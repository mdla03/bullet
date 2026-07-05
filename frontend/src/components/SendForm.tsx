"use client";

import { useEffect, useRef, useState } from "react";
import type { ResolveResult } from "@zeekpay/shared";
import { computeRecipientDigest } from "@/lib/recipient";
import { depositNote } from "@/lib/deposit";
import { encodeClaimLink, type ClaimPayload } from "@/lib/claim_link";
import { postNote } from "@/lib/notes";
import { apiFetch } from "@/lib/api";
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
  process.env.NEXT_PUBLIC_FRONTEND_URL ?? "https://bullet-frontend.vercel.app";

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
      className="inline-flex items-center gap-1.5 rounded-md border border-fog bg-white px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-graphite"
    >
      {copied ? (
        <CheckIcon className="h-3.5 w-3.5 text-signal" />
      ) : (
        <CopyIcon className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : label}
    </button>
  );
}

export function SendForm({ initialRecipient }: { initialRecipient?: string }) {
  const [recipient, setRecipient] = useState(initialRecipient ?? "");
  const [resolved, setResolved] = useState<ResolveResult | null>(null);
  const [unregistered, setUnregistered] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState<15 | 30>(30);
  const [resolving, setResolving] = useState(false);
  const [denom, setDenom] = useState<Denom>(10);
  const [step, setStep] = useState<Step>("idle");
  const [claimLink, setClaimLink] = useState("");
  const [notePosted, setNotePosted] = useState(false);
  const [sentAsInvite, setSentAsInvite] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");

  const busy = step === "computing" || step === "signing" || step === "submitting";
  const stepIndex = SEND_STEPS.findIndex((s) => s.key === step);

  // Arriving from the hero send box: resolve the prefilled handle right away.
  const autoResolved = useRef(false);
  useEffect(() => {
    if (initialRecipient?.trim() && !autoResolved.current) {
      autoResolved.current = true;
      handleResolve();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleResolve() {
    setError("");
    setResolving(true);
    setResolved(null);
    setUnregistered(null);
    try {
      const res = await fetch(
        `${RESOLVER_URL}/resolve?q=${encodeURIComponent(recipient.trim())}`
      );
      const result: ResolveResult = await res.json();
      if (!result.found || !result.stellarAddress) {
        setUnregistered(recipient.trim());
        return;
      }
      setResolved(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg === "Failed to fetch"
          ? "Can't reach the Bullet resolver. Check that the backend is running, then try again."
          : msg
      );
    } finally {
      setResolving(false);
    }
  }

  function reset() {
    setResolved(null);
    setUnregistered(null);
    setStep("idle");
    setClaimLink("");
    setNotePosted(false);
    setSentAsInvite(false);
    setTxHash("");
    setError("");
  }

  async function handleSendInvite() {
    if (!unregistered) return;
    setError("");
    setClaimLink("");
    setTxHash("");
    try {
      const { requestAccess, signTransaction } = await import(
        "@stellar/freighter-api"
      );
      const addrRes = await requestAccess();
      if ("error" in addrRes) throw new Error(`Freighter: ${addrRes.error}`);
      const senderAddress = addrRes.address;

      // Get a per-invite custody Stellar wallet from the backend.
      setStep("computing");
      const prepRes = await apiFetch("/invite/prepare", { method: "POST", body: "{}" });
      if (!prepRes.ok) {
        const err = (await prepRes.json().catch(() => ({}))) as { detail?: string };
        throw new Error(`Invite setup failed: ${err.detail ?? prepRes.status}`);
      }
      const { custodyStellarAddress, custodySecret } = (await prepRes.json()) as {
        custodyStellarAddress: string;
        custodySecret: string;
      };

      const recipientDigest = await computeRecipientDigest(custodyStellarAddress);

      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      secretBytes[0] = 0;
      const secret = Array.from(secretBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const secretBigInt = BigInt("0x" + secret);

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

      const payload: ClaimPayload = {
        secret,
        recipientDigest: recipientDigest.toString(),
        denom,
        contractId: CONTRACT_ID,
        network: "testnet",
        recipientHandle: unregistered,
      };
      setClaimLink(encodeClaimLink(payload, FRONTEND_URL));

      const commitInv = await apiFetch("/invite/commit", {
        method: "POST",
        body: JSON.stringify({
          handle: unregistered,
          denom,
          claimPayload: payload,
          custodyStellarAddress,
          custodySecret,
          expiresInDays: expiryDays,
        }),
      });
      if (!commitInv.ok) {
        // Non-fatal: deposit already happened. Sender still has the claim link
        // to hand off manually if the backend hiccups.
        const err = (await commitInv.json().catch(() => ({}))) as { detail?: string };
        console.warn("invite_record failed", err);
      }

      setSentAsInvite(true);
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("error");
    }
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

      // 3. Generate random 32-byte secret; zero top byte so value < BLS12-381 r.
      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      secretBytes[0] = 0;
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
        recipientHandle: recipient.trim(),
      };
      setClaimLink(encodeClaimLink(payload, FRONTEND_URL));

      // 7. Deliver to their Bullet inbox (encrypted to their published key).
      // Best-effort: the claim link above works even if this fails.
      if (resolved.zeekPayPubKey) {
        try {
          await postNote(payload, resolved.zeekPayPubKey);
          setNotePosted(true);
        } catch {
          setNotePosted(false);
        }
      }
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
        <div className="rounded-2xl border border-signal/30 bg-white p-5">
          <p className="flex items-center gap-2 font-semibold text-signal">
            <CheckIcon className="h-5 w-5" />${denom} USDC{" "}
            {sentAsInvite ? "sent as an invite to " : "sent silently to "}
            {recipient.trim()}
          </p>
          <p className="mt-1 text-sm text-graphite">
            {sentAsInvite
              ? `Held for ${expiryDays} days. Lands in their inbox the moment they sign up on Bullet and link a wallet. If unclaimed by then, it comes back to you.`
              : "Nothing on-chain connects your deposit to their claim."}
            {!sentAsInvite && notePosted &&
              " The note is waiting in their Bullet inbox the next time they open the app."}
          </p>
        </div>

        <div className="space-y-3 rounded-2xl border border-fog bg-white p-5">
          <p className="text-sm font-medium">
            {notePosted ? "Backup claim link" : "Deliver the claim link"}
          </p>
          <p className="text-xs text-graphite">
            {notePosted
              ? "Already delivered to their inbox. Share this link only if they can't sign in."
              : "Bullet never sends DMs. Deliver the link yourself, from an account they already trust."}
          </p>
          <div className="break-all rounded-lg bg-paper px-3 py-2 font-mono text-xs text-graphite">
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
            className="inline-flex items-center gap-1.5 text-xs text-graphite underline-offset-2 hover:text-ink hover:underline"
          >
            <ExternalLinkIcon className="h-3.5 w-3.5" />
            View deposit on stellar.expert (
            <span className="font-mono">{txHash.slice(0, 12)}…</span>)
          </a>
        )}

        <button
          onClick={() => {
            reset();
            setRecipient("");
          }}
          className="w-full rounded-full border border-fog bg-white px-4 py-3 font-medium transition-colors hover:border-graphite"
        >
          Send another
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Recipient */}
      {!resolved && !unregistered ? (
        <div>
          <label className="mb-1.5 block text-sm font-medium">Recipient</label>
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
              className="w-full rounded-xl border border-fog bg-white px-4 py-2.5 placeholder-graphite/60 focus:border-ink focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={handleResolve}
              disabled={resolving || !recipient.trim()}
              className="shrink-0 rounded-xl bg-ink px-5 py-2.5 font-medium text-paper transition-colors hover:bg-ink/85 disabled:opacity-40"
            >
              {resolving ? (
                <LoaderIcon className="h-5 w-5 animate-spin" />
              ) : (
                "Find"
              )}
            </button>
          </div>
          <p className="mt-2 text-xs text-graphite">
            No wallet address needed. Bullet resolves the handle for you.
          </p>
        </div>
      ) : unregistered ? (
        <div className="space-y-3 rounded-2xl border border-amber/40 bg-amber/5 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-lg font-bold">
              {unregistered.replace(/^@/, "").charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{unregistered}</p>
              <p className="text-xs text-graphite">
                Not on Bullet yet. Send as an invite. Bullet holds the funds
                until they sign up and link a wallet.
              </p>
            </div>
            <button
              onClick={reset}
              disabled={busy}
              className="shrink-0 text-xs text-graphite underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
            >
              Change
            </button>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-graphite">
              Refund if unclaimed after
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[15, 30].map((d) => (
                <button
                  key={d}
                  onClick={() => setExpiryDays(d as 15 | 30)}
                  disabled={busy}
                  className={`rounded-xl border px-3 py-2 text-sm transition-colors disabled:opacity-50 ${
                    expiryDays === d
                      ? "border-ink bg-ink text-paper"
                      : "border-fog bg-white text-graphite hover:border-graphite"
                  }`}
                >
                  {d} days
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl border border-fog bg-white p-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-paper text-lg font-bold">
            {recipient.trim().replace(/^@/, "").charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{recipient.trim()}</p>
            <p className="flex items-center gap-1 text-xs text-signal">
              <ShieldCheckIcon className="h-3.5 w-3.5" />
              Registered on Bullet
            </p>
          </div>
          <button
            onClick={reset}
            disabled={busy}
            className="shrink-0 text-xs text-graphite underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
          >
            Change
          </button>
        </div>
      )}

      {/* Denomination picker */}
      {(resolved || unregistered) && (
        <>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Amount</label>
            <div className="grid grid-cols-4 gap-2">
              {DENOMS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDenom(d)}
                  disabled={busy}
                  className={`rounded-xl border px-2 py-3 transition-colors disabled:opacity-50 ${
                    denom === d
                      ? "border-ink bg-ink text-paper"
                      : "border-fog bg-white text-graphite hover:border-graphite"
                  }`}
                >
                  <span className="block text-lg font-bold">${d}</span>
                  <span className="block text-[10px] tracking-wider">USDC</span>
                </button>
              ))}
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-graphite">
              <EyeOffIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Every Bullet payment uses one of these fixed amounts, so no
              single payment stands out on-chain.
            </p>
          </div>

          {/* Send button / progress rail */}
          {busy ? (
            <div className="space-y-3 rounded-2xl border border-fog bg-white p-5">
              {SEND_STEPS.map((s, i) => (
                <div key={s.key} className="flex items-center gap-3 text-sm">
                  {i < stepIndex ? (
                    <CheckIcon className="h-4 w-4 shrink-0 text-signal" />
                  ) : i === stepIndex ? (
                    <LoaderIcon className="h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <span className="h-4 w-4 shrink-0 rounded-full border border-fog" />
                  )}
                  <span
                    className={
                      i === stepIndex ? "text-ink" : "text-graphite"
                    }
                  >
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <button
              onClick={unregistered ? handleSendInvite : handleSend}
              className="w-full rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
            >
              {unregistered
                ? `Send $${denom} as invite`
                : `Send $${denom} silently`}
            </button>
          )}
        </>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
