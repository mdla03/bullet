"use client";

import { useState } from "react";
import type { ResolveResult } from "@zeekpay/shared";
import { computeRecipientDigest } from "@/lib/recipient";
import { depositNote } from "@/lib/deposit";
import { encodeClaimLink, type ClaimPayload } from "@/lib/claim_link";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  LoaderIcon,
  ShieldCheckIcon,
} from "@/components/icons";

const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const FRONTEND_URL =
  process.env.NEXT_PUBLIC_FRONTEND_URL ?? "http://localhost:3000";

const DENOMS = [1, 10, 50, 100] as const;
type Denom = (typeof DENOMS)[number];

type Step = "idle" | "computing" | "signing" | "submitting" | "done" | "error";

const SEND_STEPS: { key: Step; label: string }[] = [
  { key: "computing", label: "Creating the one-time commitment" },
  { key: "signing", label: "Sign in Freighter" },
  { key: "submitting", label: "Submitting to Stellar" },
];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500"
    >
      {copied ? (
        <CheckIcon className="h-3.5 w-3.5 text-emerald-400" />
      ) : (
        <CopyIcon className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : label}
    </button>
  );
}

export function SendForm() {
  const [recipient, setRecipient] = useState("");
  const [resolved, setResolved] = useState<ResolveResult | null>(null);
  const [resolving, setResolving] = useState(false);
  const [denom, setDenom] = useState<Denom>(10);
  const [step, setStep] = useState<Step>("idle");
  const [claimLink, setClaimLink] = useState("");
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");

  const busy = step === "computing" || step === "signing" || step === "submitting";
  const stepIndex = SEND_STEPS.findIndex((s) => s.key === step);

  async function handleResolve() {
    setError("");
    setResolving(true);
    try {
      const res = await fetch(
        `${RESOLVER_URL}/resolve?q=${encodeURIComponent(recipient.trim())}`
      );
      const result: ResolveResult = await res.json();
      if (!result.found || !result.stellarAddress) {
        throw new Error(
          `"${recipient.trim()}" isn't registered on Bullet yet. Ask them to sign up, then try again.`
        );
      }
      setResolved(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  }

  function reset() {
    setResolved(null);
    setStep("idle");
    setClaimLink("");
    setTxHash("");
    setError("");
  }

  async function handleSend() {
    if (!resolved?.stellarAddress) return;
    setError("");
    setClaimLink("");
    setTxHash("");

    try {
      // 1. Connect Freighter wallet
      const { requestAccess, signTransaction } = await import(
        "@stellar/freighter-api"
      );
      const addrRes = await requestAccess();
      if ("error" in addrRes) {
        throw new Error(`Freighter: ${addrRes.error}`);
      }
      const senderAddress = addrRes.address;

      // 2. Compute recipientDigest from resolved Stellar address
      setStep("computing");
      const recipientDigest = await computeRecipientDigest(
        resolved.stellarAddress
      );

      // 3. Generate random 32-byte secret
      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      const secret = Array.from(secretBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const secretBigInt = BigInt("0x" + secret);

      // 4. Compute commitment via backend (snarkjs BLS12-381 Poseidon)
      const commitRes = await fetch(`${RESOLVER_URL}/commitment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: secretBigInt.toString(),
          recipientDigest: recipientDigest.toString(),
          denom: denom.toString(),
        }),
      });
      if (!commitRes.ok) {
        const err = await commitRes.json().catch(() => ({}));
        throw new Error(
          `Commitment computation failed: ${(err as { detail?: string }).detail ?? commitRes.status}`
        );
      }
      const { commitment } = (await commitRes.json()) as { commitment: string };
      const commitmentBigInt = BigInt(commitment);

      // 5. Build, sign, submit deposit transaction
      setStep("signing");
      const hash = await depositNote(
        senderAddress,
        commitmentBigInt,
        denom,
        async (xdr) => {
          setStep("submitting");
          const signRes = await signTransaction(xdr, {
            networkPassphrase:
              process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ??
              "Test SDF Network ; September 2015",
          });
          if ("error" in signRes) throw new Error(`Freighter: ${signRes.error}`);
          return signRes.signedTxXdr;
        }
      );
      setTxHash(hash);

      // 6. Build claim link
      const payload: ClaimPayload = {
        secret,
        recipientDigest: recipientDigest.toString(),
        denom,
        contractId: CONTRACT_ID,
        network: "testnet",
      };
      setClaimLink(encodeClaimLink(payload, FRONTEND_URL));
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("error");
    }
  }

  const shareMessage = `I sent you $${denom} USDC on Bullet (private payments on Stellar). Claim it here: ${claimLink}. Keep this link private, it contains your claim secret.`;

  // ---- Success state ----
  if (step === "done") {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border border-emerald-900 bg-emerald-950/40 p-5">
          <p className="flex items-center gap-2 font-semibold text-emerald-300">
            <CheckIcon className="h-5 w-5" />${denom} USDC sent to{" "}
            {recipient.trim()}
          </p>
          <p className="mt-1 text-sm text-zinc-400">
            Nothing on-chain connects your deposit to their claim.
          </p>
        </div>

        <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <p className="text-sm font-medium text-zinc-200">
            Deliver the claim link
          </p>
          <p className="text-xs text-zinc-500">
            Bullet never sends DMs. Deliver the link yourself, from an account
            they already trust.
          </p>
          <div className="break-all rounded-lg bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-400">
            {claimLink}
          </div>
          <div className="flex gap-2">
            <CopyButton text={claimLink} label="Copy link" />
            <CopyButton text={shareMessage} label="Copy ready-to-send message" />
          </div>
        </div>

        {txHash && (
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
          >
            <ExternalLinkIcon className="h-3.5 w-3.5" />
            View deposit on stellar.expert ({txHash.slice(0, 12)}…)
          </a>
        )}

        <button
          onClick={() => {
            reset();
            setRecipient("");
          }}
          className="w-full rounded-xl border border-zinc-700 px-4 py-3 font-medium text-zinc-300 transition-colors hover:border-zinc-500"
        >
          Send another
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Recipient */}
      {!resolved ? (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-zinc-300">
            Recipient
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="@handle or email"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && recipient.trim() && !resolving)
                  handleResolve();
              }}
              disabled={resolving}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-zinc-100 placeholder-zinc-600 focus:border-amber-500 focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={handleResolve}
              disabled={resolving || !recipient.trim()}
              className="shrink-0 rounded-xl bg-zinc-100 px-5 py-2.5 font-medium text-zinc-950 transition-colors hover:bg-white disabled:opacity-40"
            >
              {resolving ? (
                <LoaderIcon className="h-5 w-5 animate-spin" />
              ) : (
                "Find"
              )}
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-600">
            No wallet address needed. Bullet resolves the handle for you.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-400/10 text-lg font-bold text-amber-400">
            {recipient.trim().replace(/^@/, "").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-zinc-100">
              {recipient.trim()}
            </p>
            <p className="flex items-center gap-1 text-xs text-emerald-400">
              <ShieldCheckIcon className="h-3.5 w-3.5" />
              Registered on Bullet ·{" "}
              <span className="font-mono text-zinc-500">
                {resolved.stellarAddress!.slice(0, 4)}…
                {resolved.stellarAddress!.slice(-4)}
              </span>
            </p>
          </div>
          <button
            onClick={reset}
            disabled={busy}
            className="shrink-0 text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline disabled:opacity-50"
          >
            Change
          </button>
        </div>
      )}

      {/* Denomination picker */}
      {resolved && (
        <>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">
              Amount
            </label>
            <div className="grid grid-cols-4 gap-2">
              {DENOMS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDenom(d)}
                  disabled={busy}
                  className={`rounded-xl border px-2 py-3 transition-colors disabled:opacity-50 ${
                    denom === d
                      ? "border-amber-400 bg-amber-400/10 text-amber-300"
                      : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500"
                  }`}
                >
                  <span className="block text-lg font-bold">${d}</span>
                  <span className="block text-[10px] tracking-wider text-zinc-500">
                    USDC
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-zinc-600">
              <EyeOffIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Every Bullet payment uses one of these fixed amounts, so no
              single payment stands out on-chain.
            </p>
          </div>

          {/* Send button / progress rail */}
          {busy ? (
            <div className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
              {SEND_STEPS.map((s, i) => (
                <div key={s.key} className="flex items-center gap-3 text-sm">
                  {i < stepIndex ? (
                    <CheckIcon className="h-4 w-4 shrink-0 text-emerald-400" />
                  ) : i === stepIndex ? (
                    <LoaderIcon className="h-4 w-4 shrink-0 animate-spin text-amber-400" />
                  ) : (
                    <span className="h-4 w-4 shrink-0 rounded-full border border-zinc-700" />
                  )}
                  <span
                    className={
                      i < stepIndex
                        ? "text-zinc-500"
                        : i === stepIndex
                          ? "text-zinc-100"
                          : "text-zinc-600"
                    }
                  >
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <button
              onClick={handleSend}
              className="w-full rounded-xl bg-amber-400 px-4 py-3 font-semibold text-zinc-950 transition-colors hover:bg-amber-300"
            >
              Send ${denom} privately
            </button>
          )}
        </>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
