"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import type { SVGProps } from "react";
import {
  CheckIcon,
  GoogleIcon,
  LoaderIcon,
  MailIcon,
  WalletIcon,
  XBrandIcon,
} from "@/components/icons";
import { createClient } from "@/lib/supabase/client";
import { apiFetch, getMe, lookupEmailProviders, type MeResponse } from "@/lib/api";
import { Skeleton } from "@/components/Skeleton";
import {
  KEY_DOMAIN_MESSAGE,
  buildLinkWalletChallenge,
  deriveBulletPubKey,
  signatureToHex,
} from "@/lib/register";

const PROVIDERS = [
  { key: "google", label: "Google", icon: GoogleIcon, enabled: true },
  { key: "x", label: "X", icon: XBrandIcon, enabled: true },
] as const;

const OAUTH_ERRORS: Record<string, string> = {
  missing_code: "The sign-in didn't complete. Start again.",
  access_denied: "The sign-in was cancelled. Start again when you're ready.",
};

function providerIcon(provider: string): (p: SVGProps<SVGSVGElement>) => React.ReactElement {
  if (provider === "twitter" || provider === "twitter_v2" || provider === "x")
    return XBrandIcon;
  if (provider === "google") return GoogleIcon;
  return MailIcon;
}

// Sort key: Google first, then X, then email, then anything else.
const PROVIDER_RANK: Record<string, number> = {
  google: 0,
  x: 1,
  twitter: 1,
  twitter_v2: 1,
  email: 2,
};
function providerRank(provider: string): number {
  return PROVIDER_RANK[provider] ?? 99;
}

export function RegisterFlow({
  oauthError,
  autoProvider,
}: {
  oauthError?: string;
  autoProvider?: "google" | "x";
}) {
  const supabase = createClient();

  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [address, setAddress] = useState("");
  const [working, setWorking] = useState<
    "" | "oauth" | "email" | "connect" | "link"
  >("");
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  const [resendIn, setResendIn] = useState(0);
  // provider === null means we know the email is OAuth-only but not which one;
  // UI then offers both Google and X.
  const [oauthOnly, setOauthOnly] = useState<{ provider: "google" | "x" | null } | null>(null);
  const [error, setError] = useState(
    oauthError ? (OAUTH_ERRORS[oauthError] ?? "Sign-in failed. Start again.") : ""
  );

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) =>
      setSession(s)
    );
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-trigger OAuth when arriving from hero buttons with ?provider=
  useEffect(() => {
    if (session === null && autoProvider) {
      signIn(autoProvider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, autoProvider]);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await getMe());
    } catch (e) {
      // /me can transiently 404 right after signup (profile row not created
      // yet). The backend lazy-heals; a raw error banner here reads as broken.
      console.warn("[refreshMe]", e);
    }
  }, []);

  useEffect(() => {
    if (session) refreshMe();
    else setMe(null);
  }, [session, refreshMe]);

  // Resend cooldown ticker. Client-side is UX only; Supabase enforces the real
  // rate limit server-side (default 60s per email), so a devtools user can't
  // actually spam OTPs by editing this state.
  // ponytail: 60s hard-coded, tighten via env if we ever need per-env tuning.
  useEffect(() => {
    if (!sentAt) return;
    const tick = () => {
      const left = Math.max(0, 60 - Math.floor((Date.now() - sentAt) / 1000));
      setResendIn(left);
      if (left === 0) clearInterval(id);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sentAt]);

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

  async function signInWithEmail() {
    if (resendIn > 0) return;
    setError("");
    setWorking("email");
    const trimmed = email.trim();

    // Catch OAuth-only accounts before Supabase silently drops the OTP.
    // Skipped when we're already on the "check inbox" screen (resend path):
    // the user has confirmed the flow, no need to re-check.
    if (!emailSent) {
      const { providers } = await lookupEmailProviders(trimmed).catch(() => ({
        providers: [] as string[],
      }));
      const hasEmail = providers.includes("email");
      const oauth = providers.find((p) =>
        ["google", "twitter", "twitter_v2"].includes(p)
      );
      if (providers.length > 0 && !hasEmail && oauth) {
        setWorking("");
        setOauthOnly({ provider: oauth === "google" ? "google" : "x" });
        return;
      }
    }

    // Try sign-in first (shouldCreateUser: false). If Supabase says the user
    // doesn't exist, retry as signup so new users still get a link. Doing it
    // this order avoids Supabase silently dropping magic links for existing
    // OAuth-only accounts under the anti-enumeration user_repeated_signup guard.
    const opts = { emailRedirectTo: `${window.location.origin}/auth/callback` };
    let { error: err } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { ...opts, shouldCreateUser: false },
    });
    if (err && /not found|user does not exist|Signups.*disabled/i.test(err.message)) {
      const retry = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { ...opts, shouldCreateUser: true },
      });
      err = retry.error;
    }
    setWorking("");
    if (err) {
      // Supabase's phrasing when an email is registered but has no email
      // identity (OAuth-only) OR when OTP signup is disabled. Either way, the
      // right next step is to try the OAuth provider(s), not to retry OTP.
      // We don't know which provider from Supabase; call lookup for the exact
      // one, fall back to offering both.
      if (/signups?.*not allowed|user_repeated_signup|user already registered/i.test(err.message)) {
        const { providers } = await lookupEmailProviders(trimmed).catch(() => ({
          providers: [] as string[],
        }));
        const oauth = providers.find((p) =>
          ["google", "twitter", "twitter_v2"].includes(p)
        );
        setOauthOnly({
          provider: oauth === "google" ? "google" : oauth ? "x" : null,
        });
        return;
      }
      setError(
        err.message?.trim()
          ? err.message
          : "Couldn't send the link. Email delivery is misconfigured. Try again shortly."
      );
    } else {
      setEmailSent(true);
      setSentAt(Date.now());
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setMe(null);
    setAddress("");
    // Bounce to home so every page's local state clears on remount.
    window.location.assign("/");
  }

  async function connectWallet() {
    setError("");
    setWorking("connect");
    try {
      const { freighterRequestAccess } = await import("@/lib/freighter");
      const { address: addr } = await freighterRequestAccess();
      setAddress(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking("");
    }
  }

  async function linkWallet() {
    const userId = me?.userId ?? session?.user.id;
    if (!userId) return;
    setError("");
    setWorking("link");
    try {
      const { freighterSignMessage } = await import("@/lib/freighter");

      const domainSig = await freighterSignMessage(KEY_DOMAIN_MESSAGE, address);
      const zeekPayPubKey = deriveBulletPubKey(signatureToHex(domainSig));

      const challenge = buildLinkWalletChallenge(userId);
      const linkSig = await freighterSignMessage(challenge, address);
      const signature = signatureToHex(linkSig);

      const res = await apiFetch("/wallet/link", {
        method: "POST",
        body: JSON.stringify({ stellarAddress: address, zeekPayPubKey, signature }),
      });
      // Railway/Vercel error pages come back as HTML; guard against JSON.parse
      // crashing so the user sees a real reason instead of "Unexpected token <".
      const raw = await res.text();
      const body = raw.startsWith("{")
        ? (JSON.parse(raw) as { detail?: string; error?: string })
        : {};
      if (!res.ok)
        throw new Error(
          body.detail ?? body.error ?? `Link failed (${res.status}). Backend may be down or a stale build is deployed.`
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
      <div className="space-y-4">
        <div className="space-y-4 rounded-2xl border border-fog bg-white p-5">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-11 rounded-xl" />
          <Skeleton className="h-11 rounded-full" />
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-fog" />
            <Skeleton className="h-3 w-6" />
            <div className="h-px flex-1 bg-fog" />
          </div>
          <Skeleton className="h-11 rounded-full" />
          <Skeleton className="h-11 rounded-full" />
          <div className="mt-5 flex items-center justify-center gap-2 border-t border-fog pt-4">
            <span className="h-1.5 w-6 rounded-full bg-fog" />
            <span className="h-1.5 w-1.5 rounded-full bg-fog" />
            <span className="h-1.5 w-1.5 rounded-full bg-fog" />
          </div>
        </div>
      </div>
    );
  }

  const linkedWallet = me?.wallet ?? null;
  const handles = me?.identities ?? [];
  const primaryHandle = handles[0]?.handle ?? session?.user.email ?? "";
  const stepIndex = !session ? 0 : !linkedWallet ? 1 : 2;
  const stepCount = 3;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-fog bg-white p-5">
      {/* Step 1: sign in */}
      {!session && !emailSent && !oauthOnly && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold tracking-tight">Sign in</h2>
          <div className="space-y-2">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && email.trim() && working !== "email")
                  signInWithEmail();
              }}
              disabled={working === "email"}
              className="w-full rounded-xl border border-fog bg-white px-4 py-2.5 placeholder-graphite/70 focus:border-ink focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={signInWithEmail}
              disabled={working === "email" || !email.trim()}
              className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-40"
            >
              {working === "email" ? (
                <LoaderIcon className="h-5 w-5 animate-spin" />
              ) : (
                "Sign in"
              )}
            </button>
          </div>
          <div className="flex items-center gap-3 text-xs text-graphite">
            <span className="h-px flex-1 bg-fog" />
            or
            <span className="h-px flex-1 bg-fog" />
          </div>
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              onClick={() => p.enabled && signIn(p.key)}
              disabled={!p.enabled || working === "oauth"}
              className={`flex w-full items-center justify-center gap-3 rounded-full border px-5 py-3 font-medium transition-colors ${p.enabled
                  ? "border-fog bg-white hover:border-graphite disabled:opacity-50"
                  : "cursor-not-allowed border-fog bg-paper text-graphite/70"
                }`}
            >
              {working === "oauth" && p.enabled ? (
                <LoaderIcon className="h-5 w-5 animate-spin" />
              ) : (
                <p.icon className="h-5 w-5" />
              )}
              <span>Continue with {p.label}</span>
              {!p.enabled && (
                <span className="rounded-full border border-fog bg-white px-2 py-0.5 text-[10px] text-graphite">
                  Soon
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Step 1b: oauth-only account detected */}
      {!session && oauthOnly && (() => {
        const known = oauthOnly.provider
          ? PROVIDERS.filter((x) => x.key === oauthOnly.provider)
          : PROVIDERS.slice();
        const primary = known[0];
        const label = oauthOnly.provider ? primary.label : "Google or X";
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-bold tracking-tight">
              Continue with {label}
            </h2>
            <p className="text-sm text-graphite">
              <span className="font-medium text-ink">{email}</span> is already
              signed up with {label}. Use {oauthOnly.provider ? "that" : "one of those"} to sign in.
            </p>
            {known.map((p, i) => (
              <button
                key={p.key}
                onClick={() => signIn(p.key)}
                disabled={working === "oauth"}
                className={`flex w-full items-center justify-center gap-3 rounded-full px-5 py-3 font-semibold transition-colors disabled:opacity-40 ${
                  i === 0
                    ? "bg-ink text-paper hover:bg-ink/85"
                    : "border border-fog bg-white hover:border-graphite"
                }`}
              >
                {working === "oauth" ? (
                  <LoaderIcon className="h-5 w-5 animate-spin" />
                ) : (
                  <p.icon className="h-5 w-5" />
                )}
                Continue with {p.label}
              </button>
            ))}
            <button
              onClick={() => {
                setOauthOnly(null);
                setError("");
              }}
              className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-5 py-3 font-medium transition-colors hover:border-graphite"
            >
              Use a different email
            </button>
          </div>
        );
      })()}

      {/* Step 1c: check your inbox */}
      {!session && emailSent && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold tracking-tight">Check your inbox</h2>
          <p className="text-sm text-graphite">
            Sign-in link sent to{" "}
            <span className="font-medium text-ink">{email}</span>.
          </p>
          <button
            onClick={signInWithEmail}
            disabled={working === "email" || resendIn > 0}
            className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-40"
          >
            {working === "email" ? (
              <LoaderIcon className="h-5 w-5 animate-spin" />
            ) : resendIn > 0 ? (
              `Resend in ${resendIn}s`
            ) : (
              "Resend link"
            )}
          </button>
          <button
            onClick={() => {
              setEmailSent(false);
              setSentAt(0);
              setResendIn(0);
              setError("");
            }}
            className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-5 py-3 font-medium transition-colors hover:border-graphite"
          >
            Use a different email
          </button>
        </div>
      )}

      {/* Step 2: attach a wallet */}
      {session && !linkedWallet && !address && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold tracking-tight">Attach a wallet</h2>
          <p className="text-sm text-graphite">
            Bullet needs a Stellar wallet to claim payments sent to{" "}
            <span className="font-medium text-ink">{primaryHandle || "you"}</span>.
          </p>
          <button
            onClick={connectWallet}
            disabled={working === "connect"}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
          >
            {working === "connect" ? (
              <LoaderIcon className="h-5 w-5 animate-spin" />
            ) : (
              <WalletIcon className="h-5 w-5" />
            )}
            Connect Freighter
          </button>
          <button
            onClick={signOut}
            className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-5 py-3 font-medium text-graphite transition-colors hover:border-graphite hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}

      {/* Step 2b: confirm the connected wallet */}
      {session && !linkedWallet && address && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold tracking-tight">Confirm this wallet</h2>
          <p className="text-sm text-graphite">
            Freighter will ask you to sign twice: once to derive your Bullet
            keys, once to prove ownership.
          </p>
          <div className="flex items-center gap-3 rounded-xl border border-fog px-4 py-3">
            <WalletIcon className="h-4 w-4 shrink-0 text-graphite" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">
              {address.slice(0, 6)}…{address.slice(-6)}
            </span>
            <CheckIcon className="h-4 w-4 shrink-0 text-signal" />
          </div>
          <button
            onClick={linkWallet}
            disabled={working === "link"}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
          >
            {working === "link" && (
              <LoaderIcon className="h-5 w-5 animate-spin" />
            )}
            {working === "link" ? "Waiting for Freighter…" : "Sign and link wallet"}
          </button>
          <button
            onClick={() => setAddress("")}
            className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-5 py-3 font-medium transition-colors hover:border-graphite"
          >
            Use a different wallet
          </button>
        </div>
      )}

      {/* Step 3: done */}
      {session && linkedWallet && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold tracking-tight">You&apos;re ready</h2>
          <p className="text-sm text-graphite">
            Payments to your handles land in your inbox. Only your wallet can
            claim them.
          </p>
          <div className="space-y-2">
            {[...handles]
              .sort((a, b) => providerRank(a.provider) - providerRank(b.provider))
              .map((h) => {
                const Icon = providerIcon(h.provider);
                return (
                  <div
                    key={`${h.provider}:${h.handle}`}
                    className="flex items-center gap-3 rounded-xl border border-fog px-4 py-3 text-sm"
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-medium">{h.handle}</span>
                  </div>
                );
              })}
          </div>
          <Link
            href="/inbox"
            className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 text-center font-semibold text-paper transition-colors hover:bg-ink/85"
          >
            Open inbox
          </Link>
          <Link
            href="/send"
            className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-5 py-3 text-center font-medium transition-colors hover:border-graphite"
          >
            Send money
          </Link>
        </div>
      )}

        <div
          className="mt-5 flex items-center justify-center gap-2 border-t border-fog pt-4"
          aria-label={`Step ${stepIndex + 1} of ${stepCount}`}
        >
          {Array.from({ length: stepCount }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === stepIndex ? "w-6 bg-ink" : i < stepIndex ? "w-1.5 bg-ink" : "w-1.5 bg-fog"}`}
            />
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
