"use client";

import { useState } from "react";
import { decodeClaimLink, type ClaimPayload } from "@/lib/claim_link";
import { computeRecipientDigest } from "@/lib/recipient";

type Step =
  | "no_link"
  | "invalid"
  | "ready"
  | "connecting"
  | "matched"
  | "mismatch"
  | "error";

function init(encoded: string): { step: Step; payload: ClaimPayload | null } {
  if (!encoded) return { step: "no_link", payload: null };
  const payload = decodeClaimLink(`http://localhost/claim?p=${encoded}`);
  if (!payload) return { step: "invalid", payload: null };
  return { step: "ready", payload };
}

export function ClaimView({ encoded }: { encoded: string }) {
  const [{ step, payload }, setState] = useState<{
    step: Step;
    payload: ClaimPayload | null;
  }>(() => init(encoded));
  const [connectedAddress, setConnectedAddress] = useState("");
  const [error, setError] = useState("");

  async function handleConnect() {
    setError("");
    setState((s) => ({ ...s, step: "connecting" }));
    try {
      const { getAddress } = await import("@stellar/freighter-api");
      const addrRes = await getAddress();
      if ("error" in addrRes) throw new Error(`Freighter: ${addrRes.error}`);
      const addr = addrRes.address;
      setConnectedAddress(addr);

      const digest = await computeRecipientDigest(addr);
      const matched = digest.toString() === payload!.recipientDigest;
      setState((s) => ({ ...s, step: matched ? "matched" : "mismatch" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState((s) => ({ ...s, step: "error" }));
    }
  }

  if (step === "no_link") {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 px-6 py-8 text-center space-y-2">
        <p className="text-gray-300 font-medium">No claim link found.</p>
        <p className="text-sm text-gray-500">
          Ask your sender to share the claim link with you.
        </p>
      </div>
    );
  }

  if (step === "invalid") {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950 px-6 py-8 text-center">
        <p className="text-red-300">Invalid claim link.</p>
      </div>
    );
  }

  if (!payload) return null;

  const shortContract = payload.contractId
    ? `${payload.contractId.slice(0, 8)}…${payload.contractId.slice(-4)}`
    : "—";

  const busy = step === "connecting";

  return (
    <div className="space-y-6">
      {/* Note card */}
      <div className="rounded-lg border border-purple-800 bg-purple-950 px-6 py-6">
        <p className="text-xs font-medium uppercase tracking-widest text-purple-400">
          ZeekPay Note
        </p>
        <p className="mt-3 text-4xl font-bold text-white">${payload.denom} USDC</p>
        <div className="mt-4 space-y-1 text-sm text-gray-400">
          <p>
            Network:{" "}
            <span className="text-gray-200">{payload.network}</span>
          </p>
          <p>
            Contract:{" "}
            <span className="font-mono text-gray-200">{shortContract}</span>
          </p>
        </div>
      </div>

      {/* Mismatch warning */}
      {step === "mismatch" && (
        <div className="rounded-lg border border-yellow-700 bg-yellow-950 px-4 py-3 text-sm text-yellow-300">
          This note is not for this wallet address. Connect the correct Stellar
          wallet.
        </div>
      )}

      {/* Error */}
      {step === "error" && error && (
        <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Connected address */}
      {(step === "matched" || step === "mismatch") && connectedAddress && (
        <p className="text-xs text-gray-500">
          Connected:{" "}
          <span className="font-mono">
            {connectedAddress.slice(0, 12)}…{connectedAddress.slice(-4)}
          </span>
        </p>
      )}

      {/* Connect button — shown when not yet matched */}
      {(step === "ready" ||
        step === "mismatch" ||
        step === "connecting" ||
        step === "error") && (
        <button
          onClick={handleConnect}
          disabled={busy}
          className="w-full rounded-lg bg-purple-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
        >
          {busy && (
            <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent align-middle" />
          )}
          {busy ? "Connecting…" : "Connect Wallet"}
        </button>
      )}

      {/* Claim button — shown after wallet verified, disabled until frontend-claim */}
      {step === "matched" && (
        <button
          disabled
          className="w-full rounded-lg bg-green-700 px-4 py-3 font-semibold text-white opacity-50 cursor-not-allowed"
        >
          Claim ${payload.denom} USDC
        </button>
      )}
    </div>
  );
}
