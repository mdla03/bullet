"use client";

import { useState } from "react";
import { decodeClaimLink, type ClaimPayload } from "@/lib/claim_link";
import { computeRecipientDigest } from "@/lib/recipient";
import { claimNote } from "@/lib/claim_tx";

const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";

type Step =
  | "no_link"
  | "invalid"
  | "ready"
  | "connecting"
  | "matched"
  | "mismatch"
  | "proving"
  | "signing"
  | "submitting"
  | "done"
  | "error";

const STEP_LABELS: Partial<Record<Step, string>> = {
  proving: "Generating proof…",
  signing: "Waiting for Freighter…",
  submitting: "Submitting…",
};

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
  const [txHash, setTxHash] = useState("");
  const [proveDetail, setProveDetail] = useState("");
  const [error, setError] = useState("");

  async function handleConnect() {
    setError("");
    setState((s) => ({ ...s, step: "connecting" }));
    try {
      const { requestAccess } = await import("@stellar/freighter-api");
      const addrRes = await requestAccess();
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

  async function handleClaim() {
    setError("");
    const p = payload!;

    try {
      // 1. Generate ZK proof (10-20 s)
      setProveDetail("Generating proof (~15 s)…");
      setState((s) => ({ ...s, step: "proving" }));

      const proveRes = await fetch(`${RESOLVER_URL}/prove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: BigInt("0x" + p.secret).toString(),
          recipientDigest: p.recipientDigest,
          denom: String(p.denom),
        }),
      });
      if (!proveRes.ok) {
        const err = await proveRes.json().catch(() => ({})) as { detail?: string };
        throw new Error(`Proof generation failed: ${err.detail ?? proveRes.status}`);
      }
      const { proof_a, proof_b, proof_c, nullifier, root } =
        (await proveRes.json()) as {
          proof_a: string;
          proof_b: string;
          proof_c: string;
          nullifier: string;
          root: string;
        };

      // 2. Sign + submit claim tx via Freighter (root already posted server-side inside /prove)
      setState((s) => ({ ...s, step: "signing" }));
      const { signTransaction } = await import("@stellar/freighter-api");

      const hash = await claimNote(
        connectedAddress,
        proof_a,
        proof_b,
        proof_c,
        root,
        nullifier,
        p.denom,
        async (xdr) => {
          setState((s) => ({ ...s, step: "submitting" }));
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
      setState((s) => ({ ...s, step: "done" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState((s) => ({ ...s, step: "matched" }));
    }
  }

  // ── render ──────────────────────────────────────────────────────────────────

  if (step === "no_link") {
    return (
      <div className="rounded-2xl border border-fog bg-white px-6 py-8 text-center space-y-2">
        <p className="font-medium">No claim link found.</p>
        <p className="text-sm text-graphite">
          Ask your sender to share the claim link with you.
        </p>
      </div>
    );
  }

  if (step === "invalid") {
    return (
      <div className="rounded-2xl border border-red-300 bg-red-50 px-6 py-8 text-center">
        <p className="text-red-700">Invalid claim link.</p>
      </div>
    );
  }

  if (!payload) return null;

  const shortContract = payload.contractId
    ? `${payload.contractId.slice(0, 8)}…${payload.contractId.slice(-4)}`
    : "unknown";

  const busy =
    step === "connecting" ||
    step === "proving" ||
    step === "signing" ||
    step === "submitting";

  return (
    <div className="space-y-6">
      {/* Note card */}
      <div className="rounded-2xl border border-fog bg-white px-6 py-6">
        <p className="text-sm font-bold tracking-tight">bullet</p>
        <p className="mt-4 text-5xl font-bold tracking-tight">
          ${payload.denom} USDC
        </p>
        <p className="mt-1 text-graphite">sent to you, silently</p>
        <div className="mt-5 space-y-1 text-sm text-graphite">
          <p>
            Network: <span className="text-ink">{payload.network}</span>
          </p>
          <p>
            Contract:{" "}
            <span className="font-mono text-ink">{shortContract}</span>
          </p>
        </div>
      </div>

      {/* Mismatch warning */}
      {step === "mismatch" && (
        <div className="rounded-xl border border-amber bg-amber/10 px-4 py-3 text-sm">
          This note is not for this wallet address. Connect the correct Stellar
          wallet.
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Connected address */}
      {(step === "matched" ||
        step === "mismatch" ||
        step === "proving" ||
        step === "signing" ||
        step === "submitting") &&
        connectedAddress && (
          <p className="text-xs text-graphite">
            Connected:{" "}
            <span className="font-mono">
              {connectedAddress.slice(0, 12)}…{connectedAddress.slice(-4)}
            </span>
          </p>
        )}

      {/* Connect button — pre-match states */}
      {(step === "ready" || step === "mismatch" || step === "error") && (
        <button
          onClick={handleConnect}
          className="w-full rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
        >
          Connect Wallet
        </button>
      )}

      {step === "connecting" && (
        <button
          disabled
          className="w-full rounded-full bg-ink px-4 py-3 font-semibold text-paper opacity-50"
        >
          <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-paper border-t-transparent align-middle" />
          Connecting…
        </button>
      )}

      {/* Claim button — after wallet verified */}
      {step === "matched" && (
        <button
          onClick={handleClaim}
          className="w-full rounded-full bg-signal px-4 py-3 font-semibold text-white transition-colors hover:bg-signal/85"
        >
          Claim ${payload.denom} USDC
        </button>
      )}

      {/* In-progress states */}
      {(step === "proving" || step === "signing" || step === "submitting") && (
        <button
          disabled
          className="w-full rounded-full bg-signal px-4 py-3 font-semibold text-white opacity-60"
        >
          <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent align-middle" />
          {STEP_LABELS[step]}
        </button>
      )}
      {step === "proving" && proveDetail && (
        <p className="text-center text-xs text-graphite">{proveDetail}</p>
      )}

      {/* Done */}
      {step === "done" && (
        <div className="space-y-3 rounded-2xl border border-signal/30 bg-white px-4 py-4">
          <p className="text-sm font-medium text-signal">
            ${payload.denom} USDC claimed
          </p>
          {txHash && (
            <p className="text-xs text-graphite">
              tx:{" "}
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline hover:text-ink"
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
