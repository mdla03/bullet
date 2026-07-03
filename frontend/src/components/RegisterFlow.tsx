"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import {
  CheckIcon,
  GoogleIcon,
  LoaderIcon,
  WalletIcon,
  XBrandIcon,
} from "@/components/icons";
import { createClient } from "@/lib/supabase/client";
import { apiFetch, getMe, type MeResponse } from "@/lib/api";
import {
  KEY_DOMAIN_MESSAGE,
  buildLinkWalletChallenge,
  deriveBulletPubKey,
  signatureToHex,
} from "@/lib/register";

const PROVIDERS = [
  { key: "google", label: "Google", icon: GoogleIcon },
  { key: "twitter", label: "X (Twitter)", icon: XBrandIcon },
] as const;

const OAUTH_ERRORS: Record<string, string> = {
  missing_code: "The sign-in didn't complete. Start again.",
  access_denied: "The sign-in was cancelled. Start again when you're ready.",
};

function providerLabel(provider: string): string {
  if (provider === "twitter") return "X";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function RegisterFlow({ oauthError }: { oauthError?: string }) {
  const supabase = createClient();

  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [address, setAddress] = useState("");
  const [working, setWorking] = useState<"" | "oauth" | "connect" | "link">("");
  const [error, setError] = useState(
    oauthError ? (OAUTH_ERRORS[oauthError] ?? "Sign-in failed. Start again.") : ""
  );

  // Track auth state.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) =>
      setSession(s)
    );
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once signed in, load the backend profile (identities + wallet).
  const refreshMe = useCallback(async () => {
    try {
      setMe(await getMe());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (session) refreshMe();
    else setMe(null);
  }, [session, refreshMe]);

  async function signIn(provider: (typeof PROVIDERS)[number]["key"]) {
    setError("");
    setWorking("oauth");
    const { error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (oauthErr) {
      setError(oauthErr.message);
      setWorking("");
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setMe(null);
    setAddress("");
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
    if (!me) return;
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

      // 2. Sign the wallet-link challenge binding this wallet to the user id.
      const challenge = buildLinkWalletChallenge(me.userId);
      const linkRes = await signMessage(challenge, { address });
      if (linkRes.error || !linkRes.signedMessage)
        throw new Error(
          `Freighter: ${linkRes.error?.message ?? "signature rejected"}`
        );
      const signature = signatureToHex(linkRes.signedMessage);

      // 3. Attach the wallet server-side (Bearer JWT via apiFetch).
      const res = await apiFetch("/wallet/link", {
        method: "POST",
        body: JSON.stringify({ stellarAddress: address, zeekPayPubKey, signature }),
      });
      const body = (await res.json()) as { detail?: string; error?: string };
      if (!res.ok)
        throw new Error(
          body.detail ?? body.error ?? `Link failed (${res.status})`
        );
      await refreshMe();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking("");
    }
  }

  // ---- Loading session ----
  if (session === undefined) {
    return (
      <div className="flex items-center gap-2 text-sm text-graphite">
        <LoaderIcon className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  // ---- Signed out: pick a provider ----
  if (!session) {
    return (
      <div className="space-y-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.key}
            onClick={() => signIn(p.key)}
            disabled={working === "oauth"}
            className="flex w-full items-center gap-3 rounded-full border border-fog bg-white px-5 py-3 text-left font-medium transition-colors hover:border-graphite disabled:opacity-50"
          >
            <p.icon className="h-5 w-5" />
            <span className="flex-1">Continue with {p.label}</span>
            {working === "oauth" && <LoaderIcon className="h-4 w-4 animate-spin" />}
          </button>
        ))}
        <p className="pt-1 text-xs text-graphite">
          Your handle is only used to receive payments. Bullet never posts or
          reads your account.
        </p>
        {error && (
          <div className="mt-2 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }

  // ---- Signed in: show handles + wallet-link ----
  const handles = me?.identities ?? [];
  const linkedWallet = me?.wallet ?? null;

  return (
    <div className="space-y-5">
      {/* Linked identities */}
      <div className="rounded-2xl border border-fog bg-white p-5">
        <p className="text-sm font-medium">Signed in</p>
        <div className="mt-3 space-y-2">
          {handles.length === 0 ? (
            <p className="text-sm text-graphite">Loading your handle…</p>
          ) : (
            handles.map((h) => (
              <p
                key={`${h.provider}:${h.handle}`}
                className="flex items-center gap-2 text-sm"
              >
                <CheckIcon className="h-4 w-4 text-signal" />
                <span className="text-graphite">{providerLabel(h.provider)}</span>
                <span className="font-medium">{h.handle}</span>
              </p>
            ))
          )}
        </div>
        <button
          onClick={signOut}
          className="mt-4 text-xs text-graphite underline-offset-2 hover:text-ink hover:underline"
        >
          Sign out
        </button>
      </div>

      {/* Wallet state */}
      {linkedWallet ? (
        <div className="space-y-5">
          <div className="rounded-2xl border border-signal/30 bg-white p-5">
            <p className="flex items-center gap-2 font-semibold text-signal">
              <CheckIcon className="h-5 w-5" />
              Wallet linked
            </p>
            <p className="mt-1 font-mono text-sm text-graphite">
              {linkedWallet.stellar_address.slice(0, 6)}…
              {linkedWallet.stellar_address.slice(-6)}
            </p>
            <p className="mt-2 text-sm text-graphite">
              Anyone can now pay your handle on Bullet. Payments arrive as
              private notes only your wallet can claim.
            </p>
          </div>
          <Link
            href="/send"
            className="block w-full rounded-full bg-ink px-4 py-3 text-center font-semibold text-paper transition-colors hover:bg-ink/85"
          >
            Send money
          </Link>
        </div>
      ) : (
        <div className="space-y-3 rounded-2xl border border-fog bg-white p-5">
          <p className="text-sm font-medium">Link your wallet</p>
          {!address ? (
            <>
              <p className="text-sm text-graphite">
                Connect the Stellar wallet that will claim payments sent to your
                handle.
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
                one proves this wallet is yours. No transaction is submitted and
                nothing is spent.
              </p>
              <button
                onClick={linkWallet}
                disabled={working === "link"}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
              >
                {working === "link" && <LoaderIcon className="h-5 w-5 animate-spin" />}
                {working === "link" ? "Waiting for Freighter…" : "Sign and link wallet"}
              </button>
            </>
          )}
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
