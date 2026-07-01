"use client";

import { useState } from "react";
import type { ResolveResult } from "@zeekpay/shared";
import { computeRecipientDigest } from "@/lib/recipient";
import { depositNote } from "@/lib/deposit";
import { encodeClaimLink, type ClaimPayload } from "@/lib/claim_link";

const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const FRONTEND_URL =
  process.env.NEXT_PUBLIC_FRONTEND_URL ?? "http://localhost:3000";

const DENOMS = [1, 10, 50, 100] as const;
type Denom = (typeof DENOMS)[number];

type Step =
  | "idle"
  | "resolving"
  | "computing"
  | "signing"
  | "submitting"
  | "done"
  | "error";

const STEP_LABELS: Record<Step, string> = {
  idle: "Send",
  resolving: "Resolving recipient…",
  computing: "Computing commitment…",
  signing: "Sign in Freighter…",
  submitting: "Submitting…",
  done: "Sent!",
  error: "Send",
};

export function SendForm() {
  const [recipient, setRecipient] = useState("");
  const [denom, setDenom] = useState<Denom>(10);
  const [step, setStep] = useState<Step>("idle");
  const [claimLink, setClaimLink] = useState("");
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");

  const busy = step !== "idle" && step !== "done" && step !== "error";

  async function handleSend() {
    setError("");
    setClaimLink("");
    setTxHash("");

    try {
      // 1. Resolve recipient
      setStep("resolving");
      const resolveRes = await fetch(
        `${RESOLVER_URL}/resolve?q=${encodeURIComponent(recipient.trim())}`
      );
      const resolved: ResolveResult = await resolveRes.json();
      if (!resolved.found || !resolved.stellarAddress) {
        throw new Error(`Recipient "${recipient}" not found in ZeekPay registry.`);
      }

      // 2. Connect Freighter wallet
      const { requestAccess, signTransaction } = await import(
        "@stellar/freighter-api"
      );
      const addrRes = await requestAccess();
      if ("error" in addrRes) {
        throw new Error(`Freighter: ${addrRes.error}`);
      }
      const senderAddress = addrRes.address;

      // 3. Compute recipientDigest from resolved Stellar address
      setStep("computing");
      const recipientDigest = await computeRecipientDigest(
        resolved.stellarAddress
      );

      // 4. Generate random 32-byte secret
      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      const secret = Array.from(secretBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const secretBigInt = BigInt("0x" + secret);

      // 5. Compute commitment via backend (snarkjs BLS12-381 Poseidon)
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

      // 6. Build, sign, submit deposit transaction
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

      // 7. Build claim link
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

  return (
    <div className="space-y-6">
      {/* Recipient input */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-300">
          Recipient
        </label>
        <input
          type="text"
          placeholder="@handle or email"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={busy}
          className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 text-gray-100 placeholder-gray-600 focus:border-purple-500 focus:outline-none disabled:opacity-50"
        />
      </div>

      {/* Denomination picker */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-300">
          Amount (USDC)
        </label>
        <div className="grid grid-cols-4 gap-2">
          {DENOMS.map((d) => (
            <button
              key={d}
              onClick={() => setDenom(d)}
              disabled={busy}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                denom === d
                  ? "border-purple-500 bg-purple-900 text-purple-200"
                  : "border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-500"
              }`}
            >
              ${d}
            </button>
          ))}
        </div>
      </div>

      {/* Send button */}
      <button
        onClick={handleSend}
        disabled={busy || !recipient.trim()}
        className="w-full rounded-lg bg-purple-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
      >
        {busy && (
          <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent align-middle" />
        )}
        {STEP_LABELS[step]}
      </button>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Success */}
      {step === "done" && (
        <div className="space-y-4 rounded-lg border border-green-800 bg-green-950 px-4 py-4">
          <p className="text-sm font-medium text-green-300">
            Note deposited! Share this claim link with {recipient}:
          </p>
          <div className="break-all rounded bg-gray-900 px-3 py-2 text-xs text-gray-300">
            {claimLink}
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(claimLink)}
            className="rounded bg-green-800 px-3 py-1.5 text-xs font-medium text-green-200 hover:bg-green-700"
          >
            Copy link
          </button>
          {txHash && (
            <p className="text-xs text-gray-500">
              tx:{" "}
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-gray-400 underline hover:text-gray-300"
              >
                {txHash.slice(0, 16)}…
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
