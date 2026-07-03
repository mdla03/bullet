"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import {
  CheckIcon,
  GoogleIcon,
  LoaderIcon,
  WalletIcon,
  XBrandIcon,
} from "@/components/icons";
import {
  KEY_DOMAIN_MESSAGE,
  buildLinkWalletChallenge,
  deriveBulletPubKey,
  signatureToHex,
} from "@/lib/register";

const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";

// ponytail: Google + X only for v1. X waits on the Supabase Twitter provider
// being configured (needs X client credentials).
const PROVIDERS = [
  { key: "google", label: "Google", icon: GoogleIcon, enabled: true },
  { key: "x", label: "X (Twitter)", icon: XBrandIcon, enabled: false },
] as const;

interface WalletRow {
  stellar_address: string;
  bullet_pubkey: string;
}

interface HandleRow {
  provider: string;
  handle: string;
}

export function RegisterFlow() {
  // undefined = still loading, null = signed out
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [handles, setHandles] = useState<HandleRow[]>([]);
  const [wallet, setWallet] = useState<WalletRow | null | undefined>(undefined);
  const [address, setAddress] = useState("");
  const [working, setWorking] = useState<"" | "oauth" | "connect" | "link">("");
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) =>
      setSession(s)
    );
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setHandles([]);
      setWallet(session === null ? null : undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      const [h, w] = await Promise.all([
        supabase.from("handles").select("provider, handle").order("linked_at"),
        supabase
          .from("wallets")
          .select("stellar_address, bullet_pubkey")
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setHandles((h.data as HandleRow[]) ?? []);
      setWallet((w.data as WalletRow) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  async function signIn() {
    setError("");
    setWorking("oauth");
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/register` },
    });
    if (err) {
      setError(err.message);
      setWorking("");
    }
    // On success the browser navigates away to Google.
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

  async function linkWallet() {
    if (!session) return;
    setError("");
    setWorking("link");
    try {
      const { signMessage } = await import("@stellar/freighter-api");

      // 1. Derive Bullet keys from a signature over the fixed domain message.
      const domainRes = await signMessage(KEY_DOMAIN_MESSAGE, { address });
      if (domainRes.error || !domainRes.signedMessage)
        throw new Error(
          `Freighter: ${domainRes.error?.message ?? "signature rejected"}`
        );
      const zeekPayPubKey = deriveBulletPubKey(
        signatureToHex(domainRes.signedMessage)
      );

      // 2. Sign the challenge binding this wallet to the signed-in account.
      const challengeRes = await signMessage(
        buildLinkWalletChallenge(session.user.id),
        { address }
      );
      if (challengeRes.error || !challengeRes.signedMessage)
        throw new Error(
          `Freighter: ${challengeRes.error?.message ?? "signature rejected"}`
        );
      const signature = signatureToHex(challengeRes.signedMessage);

      // 3. Attach via the resolver (verifies the signature server-side).
      const res = await fetch(`${RESOLVER_URL}/wallet/link`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ stellarAddress: address, zeekPayPubKey, signature }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        wallet?: WalletRow;
        detail?: string;
        error?: string;
      };
      if (!res.ok)
        throw new Error(
          body.detail ?? body.error ?? `Wallet link failed (${res.status})`
        );
      setWallet(
        body.wallet ?? { stellar_address: address, bullet_pubkey: zeekPayPubKey }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg === "Failed to fetch"
          ? "Can't reach the Bullet resolver. Check that the backend is running, then try again."
          : msg
      );
    } finally {
      setWorking("");
    }
  }

  const loading = session === undefined || (session && wallet === undefined);
  const stepIndex = !session ? 0 : !wallet ? 1 : 2;
  const steps = ["Account", "Wallet", "Done"];
  const primaryHandle = handles[0]?.handle ?? session?.user.email ?? "";

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-fog bg-white px-5 py-4 text-sm text-graphite">
        <LoaderIcon className="h-4 w-4 animate-spin" />
        Checking your session…
      </div>
    );
  }

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

      {/* Step 1: sign in */}
      {!session && (
        <div className="space-y-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              onClick={() => p.enabled && signIn()}
              disabled={!p.enabled || working === "oauth"}
              className={`flex w-full items-center gap-3 rounded-full border px-5 py-3 text-left font-medium transition-colors ${
                p.enabled
                  ? "border-fog bg-white hover:border-graphite disabled:opacity-50"
                  : "cursor-not-allowed border-fog bg-paper text-graphite/70"
              }`}
            >
              {working === "oauth" && p.enabled ? (
                <LoaderIcon className="h-5 w-5 animate-spin" />
              ) : (
                <p.icon className="h-5 w-5" />
              )}
              <span className="flex-1">Continue with {p.label}</span>
              {!p.enabled && (
                <span className="rounded-full border border-fog bg-white px-2 py-0.5 text-[10px] text-graphite">
                  Soon
                </span>
              )}
            </button>
          ))}
          <p className="pt-1 text-xs text-graphite">
            Your account is only used to receive payments. Bullet never posts
            or reads anything.
          </p>
        </div>
      )}

      {/* Step 2: attach a wallet */}
      {session && !wallet && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl border border-fog bg-white px-4 py-3">
            <CheckIcon className="h-4 w-4 shrink-0 text-signal" />
            <span className="min-w-0 flex-1 truncate text-sm">
              Signed in as <span className="font-medium">{primaryHandle}</span>
            </span>
            <button
              onClick={() => supabase.auth.signOut()}
              className="shrink-0 text-xs text-graphite underline-offset-2 hover:text-ink hover:underline"
            >
              Sign out
            </button>
          </div>

          {!address ? (
            <>
              <p className="text-sm text-graphite">
                Connect the Stellar wallet that will claim payments sent to{" "}
                <span className="text-ink">{primaryHandle}</span>.
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
                one proves this wallet is yours. No transaction is submitted
                and nothing is spent.
              </p>
              <button
                onClick={linkWallet}
                disabled={working === "link"}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
              >
                {working === "link" && (
                  <LoaderIcon className="h-5 w-5 animate-spin" />
                )}
                {working === "link" ? "Waiting for Freighter…" : "Sign and link wallet"}
              </button>
              <button
                onClick={() => setAddress("")}
                className="w-full text-center text-xs text-graphite underline-offset-2 hover:text-ink hover:underline"
              >
                Use a different wallet
              </button>
            </>
          )}
        </div>
      )}

      {/* Step 3: done */}
      {session && wallet && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-signal/30 bg-white p-5">
            <p className="flex items-center gap-2 font-semibold text-signal">
              <CheckIcon className="h-5 w-5" />
              {primaryHandle} can now get paid on Bullet
            </p>
            <p className="mt-1 text-sm text-graphite">
              Payments arrive as private notes in your inbox. Only the wallet{" "}
              <span className="font-mono">
                {wallet.stellar_address.slice(0, 4)}…
                {wallet.stellar_address.slice(-4)}
              </span>{" "}
              can claim them.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/inbox"
              className="flex-1 rounded-full bg-ink px-4 py-3 text-center font-semibold text-paper transition-colors hover:bg-ink/85"
            >
              Open inbox
            </Link>
            <Link
              href="/send"
              className="flex-1 rounded-full border border-fog bg-white px-4 py-3 text-center font-medium transition-colors hover:border-graphite"
            >
              Send money
            </Link>
          </div>
          <button
            onClick={() => supabase.auth.signOut()}
            className="w-full text-center text-xs text-graphite underline-offset-2 hover:text-ink hover:underline"
          >
            Sign out
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
