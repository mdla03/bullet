"use client";

import { useEffect, useRef, useState } from "react";
import type { ResolveResult } from "@zeekpay/shared";
import { computeRecipientDigest } from "@/lib/recipient";
import { deriveStealthDigest } from "@/lib/stealth";
import { computeCommitment } from "@/lib/commitment";
import { depositNote } from "@/lib/deposit";
import { encodeClaimLink, type ClaimPayload } from "@/lib/claim_link";
import { postNote } from "@/lib/notes";
import { apiFetch, postActivity } from "@/lib/api";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderIcon,
} from "@/components/icons";

const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
function getFrontendUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_FRONTEND_URL ?? "https://bullet-frontend.vercel.app";
}

// Token configuration: id, label, unit presets, decimals (stroops).
interface TokenConfig {
  id: number;
  label: string;
  prefix: string;  // "$" for USDC, "" for XLM
  presets: readonly number[];
  decimals: bigint;
}
const TOKENS: TokenConfig[] = [
  { id: 0, label: "USDC", prefix: "$", presets: [1, 10, 50, 100], decimals: 10_000_000n },
  { id: 1, label: "XLM",  prefix: "",  presets: [10, 50, 100, 500], decimals: 10_000_000n },
  { id: 2, label: "USDT", prefix: "$", presets: [1, 10, 50, 100], decimals: 10_000_000n },
];

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
  const [selectedToken, setSelectedToken] = useState(TOKENS[0]);
  const [selectedAmount, setSelectedAmount] = useState<number | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [claimLink, setClaimLink] = useState("");
  const [notePosted, setNotePosted] = useState(false);
  const [sentAsInvite, setSentAsInvite] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");
  const [inviteWarn, setInviteWarn] = useState(false);
  const [dontWarnAgain, setDontWarnAgain] = useState(false);

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
      const { freighterRequestAccess, freighterSignTransaction } = await import(
        "@/lib/freighter"
      );
      const { address: senderAddress } = await freighterRequestAccess();

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

      const amountStroops = BigInt(selectedAmount!) * selectedToken.decimals;

      // Commitment computed locally so the claim secret never leaves the tab.
      const commitment = computeCommitment(
        secretBigInt.toString(),
        recipientDigest.toString(),
        amountStroops.toString(),
        String(selectedToken.id)
      );
      const commitmentBigInt = BigInt(commitment);

      setStep("signing");
      const hash = await depositNote(
        senderAddress,
        commitmentBigInt,
        amountStroops,
        async (xdr) => {
          setStep("submitting");
          return freighterSignTransaction(
            xdr,
            process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015"
          );
        },
        selectedToken.id
      );
      setTxHash(hash);

      const payload: ClaimPayload = {
        secret,
        recipientDigest: recipientDigest.toString(),
        amount: Number(amountStroops),
        tokenId: selectedToken.id,
        contractId: CONTRACT_ID,
        network: "testnet",
        recipientHandle: unregistered,
      };
      setClaimLink(encodeClaimLink(payload, getFrontendUrl()));

      const commitInv = await apiFetch("/invite/commit", {
        method: "POST",
        body: JSON.stringify({
          handle: unregistered,
          amount: Number(amountStroops),
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

      postActivity({ type: "send", amount: Number(amountStroops), tokenId: selectedToken.id, txHash: hash, handle: unregistered });
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
      const { freighterRequestAccess, freighterSignTransaction } = await import(
        "@/lib/freighter"
      );
      const { address: senderAddress } = await freighterRequestAccess();

      // 2. Derive per-payment stealth recipientDigest via ECDH with recipient's bullet key.
      setStep("computing");
      const { recipientDigest: recipientDigestDec, ephemeralPubHex } =
        deriveStealthDigest(resolved.zeekPayPubKey!);
      // 3. Generate random 32-byte secret; zero top byte so value < BLS12-381 r.
      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      secretBytes[0] = 0;
      const secret = Array.from(secretBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const secretBigInt = BigInt("0x" + secret);

      const amountStroops = BigInt(selectedAmount!) * selectedToken.decimals;

      // 4. Compute commitment locally so the claim secret never leaves the tab.
      const commitment = computeCommitment(
        secretBigInt.toString(),
        recipientDigestDec,
        amountStroops.toString(),
        String(selectedToken.id)
      );
      const commitmentBigInt = BigInt(commitment);

      // 5. Build, sign, submit deposit transaction
      setStep("signing");
      const hash = await depositNote(
        senderAddress,
        commitmentBigInt,
        amountStroops,
        async (xdr) => {
          setStep("submitting");
          return freighterSignTransaction(
            xdr,
            process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015"
          );
        },
        selectedToken.id
      );
      setTxHash(hash);

      // 6. Build claim link
      const payload: ClaimPayload = {
        secret,
        recipientDigest: recipientDigestDec,
        amount: Number(amountStroops),
        tokenId: selectedToken.id,
        contractId: CONTRACT_ID,
        network: "testnet",
        recipientHandle: recipient.trim(),
        ephemeralPubkey: ephemeralPubHex,
      };
      setClaimLink(encodeClaimLink(payload, getFrontendUrl()));

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
      postActivity({ type: "send", amount: Number(amountStroops), tokenId: selectedToken.id, txHash: hash, handle: recipient.trim() });
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("error");
    }
  }

  const displayAmt = selectedAmount != null ? `${selectedToken.prefix}${selectedAmount}` : "";
  const shareMessage = `I sent you ${displayAmt} ${selectedToken.label} on Bullet (private payments on Stellar). Claim it here: ${claimLink}. Keep this link private, it contains your claim secret.`;

  // ---- Success state ----
  if (step === "done") {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-fog bg-white p-5 space-y-4">
          <div className="flex items-center gap-2">
            <CheckIcon className="h-5 w-5 text-signal" />
            <h2 className="text-xl font-bold tracking-tight">Sent</h2>
          </div>
          <p className="text-sm text-graphite">
            <span className="font-medium text-ink">{displayAmt} {selectedToken.label}</span>{" "}
            {sentAsInvite ? "held for " : "delivered silently to "}
            <span className="font-medium text-ink">{recipient.trim()}</span>
            {sentAsInvite && `. Held for ${expiryDays} days, then refunded if unclaimed.`}
          </p>

          <div className="space-y-2">
            <p className="text-xs font-medium text-graphite">
              {notePosted ? "Backup claim link" : "Deliver the claim link"}
            </p>
            <div className="break-all rounded-xl border border-fog bg-paper px-3 py-2.5 font-mono text-xs text-graphite">
              {claimLink}
            </div>
            <div className="flex gap-2">
              <CopyButton text={claimLink} label="Copy link" />
              <CopyButton text={shareMessage} label="Copy message" />
            </div>
          </div>

          {txHash && (
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-graphite hover:text-ink"
            >
              <ExternalLinkIcon className="h-3.5 w-3.5" />
              View on stellar.expert
            </a>
          )}
        </div>

        <button
          onClick={() => {
            reset();
            setRecipient("");
          }}
          className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
        >
          Send another
        </button>
      </div>
    );
  }

  const showAmountStep = !!(resolved || unregistered);
  const recipientLabel = (resolved ? recipient : unregistered ?? "").trim();
  const avatarInitial = recipientLabel.replace(/^@/, "").charAt(0).toUpperCase();

  return (
    <div className="space-y-5 rounded-2xl border border-fog bg-white p-6">
      <h2 className="text-xl font-bold tracking-tight">Send</h2>

      {!showAmountStep ? (
        <div className="space-y-3">
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
            className="w-full rounded-xl border border-fog bg-white px-4 py-3 placeholder-graphite/70 focus:border-ink focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={handleResolve}
            disabled={resolving || !recipient.trim()}
            className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-40"
          >
            {resolving ? (
              <LoaderIcon className="h-5 w-5 animate-spin" />
            ) : (
              "Find recipient"
            )}
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-xl border border-fog px-3 py-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-paper text-sm font-bold">
              {avatarInitial}
            </div>
            <p className="min-w-0 flex-1 truncate text-sm font-medium">
              {recipientLabel}
            </p>
            <button
              onClick={reset}
              disabled={busy}
              className="shrink-0 rounded-full border border-fog px-3 py-1.5 text-xs font-medium text-graphite transition-colors hover:border-graphite hover:text-ink disabled:opacity-50"
            >
              Change
            </button>
          </div>

          <div className="relative flex rounded-full border border-fog p-1">
            <div
              className="absolute bottom-1 top-1 rounded-full bg-ink transition-[left] duration-300 ease-out"
              style={{
                width: `calc((100% - 8px) / ${TOKENS.length})`,
                left: `calc(4px + ${TOKENS.findIndex((t) => t.id === selectedToken.id)} * (100% - 8px) / ${TOKENS.length})`,
              }}
              aria-hidden
            />
            {TOKENS.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setSelectedToken(t);
                  setSelectedAmount(null);
                }}
                disabled={busy}
                className={`relative z-10 flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors duration-200 disabled:opacity-50 ${
                  selectedToken.id === t.id
                    ? "text-paper"
                    : "text-graphite hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-4 gap-2">
            {selectedToken.presets.map((d) => (
              <button
                key={d}
                onClick={() => setSelectedAmount(d)}
                disabled={busy}
                className={`rounded-xl border px-2 py-4 text-lg font-bold transition-all duration-200 ease-out active:scale-95 disabled:opacity-50 ${
                  selectedAmount === d
                    ? "border-ink bg-ink text-paper shadow-md shadow-ink/10"
                    : "border-fog text-graphite hover:border-graphite"
                }`}
              >
                {selectedToken.prefix}{d}
              </button>
            ))}
          </div>

          {unregistered && (
            <div className="relative flex rounded-full border border-fog p-1">
              <div
                className="absolute bottom-1 top-1 rounded-full bg-ink transition-[left] duration-300 ease-out"
                style={{
                  width: `calc((100% - 8px) / 2)`,
                  left: `calc(4px + ${expiryDays === 15 ? 0 : 1} * (100% - 8px) / 2)`,
                }}
                aria-hidden
              />
              {[15, 30].map((d) => (
                <button
                  key={d}
                  onClick={() => setExpiryDays(d as 15 | 30)}
                  disabled={busy}
                  className={`relative z-10 flex-1 rounded-full px-4 py-2 text-xs font-medium transition-colors duration-200 disabled:opacity-50 ${
                    expiryDays === d ? "text-paper" : "text-graphite hover:text-ink"
                  }`}
                >
                  Refund after {d} days
                </button>
              ))}
            </div>
          )}

          {busy ? (
            <div className="space-y-2.5 rounded-xl border border-fog bg-paper p-4">
              {SEND_STEPS.map((s, i) => (
                <div key={s.key} className="flex items-center gap-3 text-sm">
                  {i < stepIndex ? (
                    <CheckIcon className="h-4 w-4 shrink-0 text-signal" />
                  ) : i === stepIndex ? (
                    <LoaderIcon className="h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <span className="h-4 w-4 shrink-0 rounded-full border border-fog" />
                  )}
                  <span className={i === stepIndex ? "text-ink" : "text-graphite"}>
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <button
              onClick={() => {
                if (unregistered) {
                  const skip = localStorage.getItem("bullet-hide-invite-warning") === "1";
                  if (skip) {
                    handleSendInvite();
                  } else {
                    setInviteWarn(true);
                  }
                } else {
                  handleSend();
                }
              }}
              disabled={selectedAmount === null}
              className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-40"
            >
              {selectedAmount === null
                ? "Choose an amount"
                : `Send ${displayAmt} ${selectedToken.label} ${unregistered ? "as invite" : "silently"}`}
            </button>
          )}
        </>
      )}

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {inviteWarn && unregistered && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm"
          onClick={() => setInviteWarn(false)}
        >
          <div
            className="w-full max-w-sm space-y-4 rounded-2xl border border-fog bg-white p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold tracking-tight">
              {unregistered} isn&apos;t on Bullet yet
            </h3>
            <p className="text-sm text-graphite">
              The funds sit in a custody wallet and land in their inbox the
              moment they sign up. If they don&apos;t claim within{" "}
              <span className="font-medium text-ink">{expiryDays} days</span>,
              you get them back.
            </p>
            <label className="flex items-center gap-2 text-sm text-graphite">
              <input
                type="checkbox"
                checked={dontWarnAgain}
                onChange={(e) => setDontWarnAgain(e.target.checked)}
                className="h-4 w-4 rounded border-fog accent-ink"
              />
              Don&apos;t show this again
            </label>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setInviteWarn(false)}
                className="flex-1 rounded-full border border-fog bg-white px-5 py-2.5 font-medium transition-colors hover:border-graphite"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (dontWarnAgain)
                    localStorage.setItem("bullet-hide-invite-warning", "1");
                  setInviteWarn(false);
                  handleSendInvite();
                }}
                className="flex-1 rounded-full bg-ink px-5 py-2.5 font-semibold text-paper transition-colors hover:bg-ink/85"
              >
                Send anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
