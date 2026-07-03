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
        <div className="rounded-2xl border border-emerald-900 bg-emerald-950/40 p-5">
          <p className="flex items-center gap-2 font-semibold text-emerald-300">
            <CheckIcon className="h-5 w-5" />
            {successHandle} is linked to your wallet
          </p>
          <p className="mt-1 text-sm text-zinc-400">
            Anyone can now pay {successHandle} on Bullet. Payments arrive as
            private notes only your wallet can claim.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/send"
            className="flex-1 rounded-xl bg-amber-400 px-4 py-3 text-center font-semibold text-zinc-950 transition-colors hover:bg-amber-300"
          >
            Send money
          </Link>
          <Link
            href="/register"
            className="flex-1 rounded-xl border border-zinc-700 px-4 py-3 text-center font-medium text-zinc-300 transition-colors hover:border-zinc-500"
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
                  ? "border-amber-400 bg-amber-400 text-zinc-950"
                  : i === stepIndex
                    ? "border-amber-400 text-amber-400"
                    : "border-zinc-700 text-zinc-600"
              }`}
            >
              {i < stepIndex ? <CheckIcon className="h-3 w-3" /> : i + 1}
            </span>
            <span className={i === stepIndex ? "text-zinc-200" : "text-zinc-600"}>
              {s}
            </span>
            {i < steps.length - 1 && <span className="w-4 border-t border-zinc-800" />}
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
              className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left font-medium transition-colors ${
                p.enabled
                  ? "border-zinc-700 bg-zinc-900 text-zinc-100 hover:border-zinc-500"
                  : "cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600"
              }`}
            >
              <p.icon className="h-5 w-5" />
              <span className="flex-1">Continue with {p.label}</span>
              {!p.enabled && (
                <span className="rounded-full border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-600">
                  Soon
                </span>
              )}
            </button>
          ))}
          <p className="pt-1 text-xs text-zinc-600">
            Your handle is only used to receive payments. Bullet never posts or
            reads your account.
          </p>
        </div>
      )}

      {/* Phase: enter the handle */}
      {phase === "handle" && (
        <div className="space-y-3">
          <label className="block text-sm font-medium text-zinc-300">
            Your X handle
          </label>
          <input
            type="text"
            placeholder="@handle"
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && normalizeHandle(handleInput)) setPhase("wallet");
            }}
            autoFocus
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-zinc-100 placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
          />
          <p className="text-xs text-zinc-600">
            You'll sign in to X in a moment to prove it's yours.
          </p>
          <button
            onClick={() => setPhase("wallet")}
            disabled={!normalizeHandle(handleInput)}
            className="w-full rounded-xl bg-amber-400 px-4 py-3 font-semibold text-zinc-950 transition-colors hover:bg-amber-300 disabled:opacity-40"
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
              <p className="text-sm text-zinc-400">
                Connect the Stellar wallet that will claim payments sent to{" "}
                <span className="text-zinc-200">{normalizeHandle(handleInput)}</span>.
              </p>
              <button
                onClick={connectWallet}
                disabled={working === "connect"}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3 font-semibold text-zinc-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
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
              <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                <WalletIcon className="h-5 w-5 text-amber-400" />
                <span className="font-mono text-sm text-zinc-300">
                  {address.slice(0, 6)}…{address.slice(-6)}
                </span>
                <CheckIcon className="ml-auto h-4 w-4 text-emerald-400" />
              </div>
              <p className="text-xs text-zinc-600">
                Two Freighter signatures follow: one derives your Bullet keys,
                one proves this wallet owns the handle. Then X opens to verify
                the handle itself. No transaction is submitted and nothing is
                spent.
              </p>
              <button
                onClick={signAndVerify}
                disabled={working === "sign"}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3 font-semibold text-zinc-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
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
            className="w-full text-center text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
          >
            Start over
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
