"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CheckIcon,
  GoogleIcon,
  LoaderIcon,
  WalletIcon,
  XBrandIcon,
} from "@/components/icons";
import {
  KEY_DOMAIN_MESSAGE,
  buildChallenge,
  deriveBulletPubKey,
  normalizeHandle,
  signatureToHex,
} from "@/lib/register";

const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";

// ponytail: Google + X only for v1 (WhatsApp/Instagram have no free OAuth,
// Telegram cut). Google button enables when backend /auth/google/* lands.
const PROVIDERS = [
  { key: "x", label: "X (Twitter)", icon: XBrandIcon, enabled: true },
  { key: "google", label: "Google", icon: GoogleIcon, enabled: false },
] as const;

const OAUTH_ERRORS: Record<string, string> = {
  cancelled: "The X sign-in was cancelled. Start again when you're ready.",
  expired: "The session expired. Start again.",
  handle_mismatch:
    "The X account you signed in with doesn't match the handle you entered.",
  conflict: "That handle is already registered to a wallet.",
};

type Phase = "provider" | "handle" | "wallet";

export function RegisterFlow({
  successHandle,
  oauthError,
}: {
  successHandle?: string;
  oauthError?: string;
}) {
  const [phase, setPhase] = useState<Phase>("provider");
  const [handleInput, setHandleInput] = useState("");
  const [address, setAddress] = useState("");
  const [working, setWorking] = useState<"" | "connect" | "sign">("");
  const [error, setError] = useState(
    oauthError ? (OAUTH_ERRORS[oauthError] ?? "Sign-in failed. Start again.") : ""
  );

  // ---- Registered: the OAuth callback landed with success=1 ----
  if (successHandle) {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border border-signal/30 bg-white p-5">
          <p className="flex items-center gap-2 font-semibold text-signal">
            <CheckIcon className="h-5 w-5" />
            {successHandle} is linked to your wallet
          </p>
          <p className="mt-1 text-sm text-graphite">
            Anyone can now pay {successHandle} on Bullet. Payments arrive as
            private notes only your wallet can claim.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/send"
            className="flex-1 rounded-full bg-ink px-4 py-3 text-center font-semibold text-paper transition-colors hover:bg-ink/85"
          >
            Send money
          </Link>
          <Link
            href="/register"
            className="flex-1 rounded-full border border-fog bg-white px-4 py-3 text-center font-medium transition-colors hover:border-graphite"
          >
            Link another handle
          </Link>
        </div>
      </div>
    );
  }

  async function connectWallet() {
    setError("");
    setWorking("connect");
    try {
      const { requestAccess } = await import("@stellar/freighter-api");
      const res = await requestAccess();
      if ("error" in res && res.error) throw new Error(`Freighter: ${res.error}`);
      setAddress(res.address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking("");
    }
  }

  async function signAndVerify() {
    const handle = normalizeHandle(handleInput);
    if (!handle) return;
    setError("");
    setWorking("sign");
    try {
      const { signMessage } = await import("@stellar/freighter-api");

      // 1. Derive Bullet keys from a signature over the fixed domain message.
      const domainRes = await signMessage(KEY_DOMAIN_MESSAGE, { address });
      if (domainRes.error || !domainRes.signedMessage)
        throw new Error(`Freighter: ${domainRes.error?.message ?? "signature rejected"}`);
      const zeekPayPubKey = deriveBulletPubKey(
        signatureToHex(domainRes.signedMessage)
      );

      // 2. Sign the registration challenge binding handle to wallet.
      const challengeRes = await signMessage(buildChallenge(handle, address), {
        address,
      });
      if (challengeRes.error || !challengeRes.signedMessage)
        throw new Error(`Freighter: ${challengeRes.error?.message ?? "signature rejected"}`);
      const signature = signatureToHex(challengeRes.signedMessage);

      // 3. Start X OAuth; backend registers after the handle is verified.
      const res = await fetch(`${RESOLVER_URL}/auth/twitter/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, stellarAddress: address, zeekPayPubKey, signature }),
      });
      const body = (await res.json()) as { authUrl?: string; detail?: string; error?: string };
      if (!res.ok || !body.authUrl)
        throw new Error(body.detail ?? body.error ?? `Registration failed (${res.status})`);
      window.location.href = body.authUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWorking("");
    }
  }

  const steps = ["Account", "Wallet", "Verify"];
  const stepIndex = phase === "provider" || phase === "handle" ? 0 : 1;

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <ol className="flex items-center gap-2 text-xs">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold ${
                i < stepIndex
                  ? "border-ink bg-ink text-paper"
                  : i === stepIndex
                    ? "border-ink text-ink"
                    : "border-fog text-graphite"
              }`}
            >
              {i < stepIndex ? <CheckIcon className="h-3 w-3" /> : i + 1}
            </span>
            <span className={i === stepIndex ? "text-ink" : "text-graphite"}>
              {s}
            </span>
            {i < steps.length - 1 && <span className="w-4 border-t border-fog" />}
          </li>
        ))}
      </ol>

      {/* Phase: pick a provider */}
      {phase === "provider" && (
        <div className="space-y-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              onClick={() => p.enabled && setPhase("handle")}
              disabled={!p.enabled}
              className={`flex w-full items-center gap-3 rounded-full border px-5 py-3 text-left font-medium transition-colors ${
                p.enabled
                  ? "border-fog bg-white hover:border-graphite"
                  : "cursor-not-allowed border-fog bg-paper text-graphite/70"
              }`}
            >
              <p.icon className="h-5 w-5" />
              <span className="flex-1">Continue with {p.label}</span>
              {!p.enabled && (
                <span className="rounded-full border border-fog bg-white px-2 py-0.5 text-[10px] text-graphite">
                  Soon
                </span>
              )}
            </button>
          ))}
          <p className="pt-1 text-xs text-graphite">
            Your handle is only used to receive payments. Bullet never posts or
            reads your account.
          </p>
        </div>
      )}

      {/* Phase: enter the handle */}
      {phase === "handle" && (
        <div className="space-y-3">
          <label className="block text-sm font-medium">Your X handle</label>
          <input
            type="text"
            placeholder="@handle"
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && normalizeHandle(handleInput)) setPhase("wallet");
            }}
            autoFocus
            className="w-full rounded-xl border border-fog bg-white px-4 py-2.5 placeholder-graphite/60 focus:border-ink focus:outline-none"
          />
          <p className="text-xs text-graphite">
            You'll sign in to X in a moment to prove it's yours.
          </p>
          <button
            onClick={() => setPhase("wallet")}
            disabled={!normalizeHandle(handleInput)}
            className="w-full rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-40"
          >
            Continue
          </button>
        </div>
      )}

      {/* Phase: connect wallet, then sign and go verify */}
      {phase === "wallet" && (
        <div className="space-y-3">
          {!address ? (
            <>
              <p className="text-sm text-graphite">
                Connect the Stellar wallet that will claim payments sent to{" "}
                <span className="text-ink">{normalizeHandle(handleInput)}</span>.
              </p>
              <button
                onClick={connectWallet}
                disabled={working === "connect"}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
              >
                {working === "connect" ? (
                  <LoaderIcon className="h-5 w-5 animate-spin" />
                ) : (
                  <WalletIcon className="h-5 w-5" />
                )}
                Connect Freighter
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 rounded-xl border border-fog bg-white px-4 py-3">
                <WalletIcon className="h-5 w-5" />
                <span className="font-mono text-sm text-graphite">
                  {address.slice(0, 6)}…{address.slice(-6)}
                </span>
                <CheckIcon className="ml-auto h-4 w-4 text-signal" />
              </div>
              <p className="text-xs text-graphite">
                Two Freighter signatures follow: one derives your Bullet keys,
                one proves this wallet owns the handle. Then X opens to verify
                the handle itself. No transaction is submitted and nothing is
                spent.
              </p>
              <button
                onClick={signAndVerify}
                disabled={working === "sign"}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
              >
                {working === "sign" && <LoaderIcon className="h-5 w-5 animate-spin" />}
                {working === "sign" ? "Waiting for Freighter…" : "Sign and verify on X"}
              </button>
            </>
          )}
          <button
            onClick={() => {
              setPhase("provider");
              setAddress("");
            }}
            className="w-full text-center text-xs text-graphite underline-offset-2 hover:text-ink hover:underline"
          >
            Start over
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
