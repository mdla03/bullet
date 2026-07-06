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
  { key: "google", label: "Google", icon: GoogleIcon, enabled: true },
  { key: "x", label: "X (Twitter)", icon: XBrandIcon, enabled: true },
] as const;

const OAUTH_ERRORS: Record<string, string> = {
  missing_code: "The sign-in didn't complete. Start again.",
  access_denied: "The sign-in was cancelled. Start again when you're ready.",
};

function providerLabel(provider: string): string {
  if (provider === "twitter" || provider === "twitter_v2" || provider === "x")
    return "X";
  if (provider === "email") return "Email";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function RegisterFlow({ oauthError }: { oauthError?: string }) {
  const supabase = createClient();

  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [address, setAddress] = useState("");
  const [working, setWorking] = useState<
    "" | "oauth" | "email" | "connect" | "link" | "add_email" | `unlink:${string}`
  >("");
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addEmailSent, setAddEmailSent] = useState(false);
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

  async function signInWithEmail() {
    setError("");
    setEmailSent(false);
    setWorking("email");
    // Try sign-in first (shouldCreateUser: false). If Supabase says the user
    // doesn't exist, retry as signup so new users still get a link. Doing it
    // this order avoids Supabase silently dropping magic links for existing
    // OAuth-only accounts under the anti-enumeration user_repeated_signup guard.
    const trimmed = email.trim();
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
    if (err)
      setError(
        err.message?.trim()
          ? err.message
          : "Couldn't send the link. Email delivery is misconfigured. Try again shortly."
      );
    else setEmailSent(true);
  }

  async function linkProvider(provider: "google" | "x") {
    setError("");
    setWorking("oauth");
    const { error: err } = await supabase.auth.linkIdentity({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (err) {
      // Common: 'Identity is already linked to another user'
      setError(err.message);
      setWorking("");
    }
  }

  async function addEmailIdentity() {
    setError("");
    setAddEmailSent(false);
    setWorking("add_email");
    const { error: err } = await supabase.auth.updateUser({
      email: addEmail.trim(),
    });
    setWorking("");
    if (err) setError(err.message);
    else setAddEmailSent(true);
  }

  async function unlinkHandle(provider: string, handle: string) {
    setError("");
    setWorking(`unlink:${provider}:${handle}`);
    try {
      const { data, error: e1 } = await supabase.auth.getUserIdentities();
      if (e1) throw new Error(e1.message);
      const identity = data?.identities?.find((i) => i.provider === provider);
      if (!identity) throw new Error("Identity not found for this handle");
      if ((data?.identities?.length ?? 0) <= 1)
        throw new Error(
          "Can't remove your last sign-in method. Add another first."
        );
      const { error: e2 } = await supabase.auth.unlinkIdentity(identity);
      if (e2) throw new Error(e2.message);
      await refreshMe();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking("");
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

      const domainRes = await signMessage(KEY_DOMAIN_MESSAGE, { address });
      if (domainRes.error || !domainRes.signedMessage)
        throw new Error(
          `Freighter: ${domainRes.error?.message ?? "signature rejected"}`
        );
      const zeekPayPubKey = deriveBulletPubKey(
        signatureToHex(domainRes.signedMessage)
      );

      const challenge = buildLinkWalletChallenge(me.userId);
      const linkRes = await signMessage(challenge, { address });
      if (linkRes.error || !linkRes.signedMessage)
        throw new Error(
          `Freighter: ${linkRes.error?.message ?? "signature rejected"}`
        );
      const signature = signatureToHex(linkRes.signedMessage);

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

  const linkedWallet = me?.wallet ?? null;
  const handles = me?.identities ?? [];
  const primaryHandle = handles[0]?.handle ?? session?.user.email ?? "";
  const stepIndex = !session ? 0 : !linkedWallet ? 1 : 2;
  const steps = ["Account", "Wallet", "Done"];

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
          <div className="space-y-2 rounded-2xl border border-fog bg-white p-4">
            <label className="block text-sm font-medium">Email sign-in</label>
            <div className="flex gap-2">
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && email.trim() && working !== "email")
                    signInWithEmail();
                }}
                disabled={working === "email"}
                className="w-full rounded-xl border border-fog bg-white px-4 py-2.5 placeholder-graphite/60 focus:border-ink focus:outline-none disabled:opacity-50"
              />
              <button
                onClick={signInWithEmail}
                disabled={working === "email" || !email.trim()}
                className="shrink-0 rounded-xl bg-ink px-5 py-2.5 font-medium text-paper transition-colors hover:bg-ink/85 disabled:opacity-40"
              >
                {working === "email" ? (
                  <LoaderIcon className="h-5 w-5 animate-spin" />
                ) : (
                  "Send link"
                )}
              </button>
            </div>
            {emailSent && (
              <p className="text-xs text-signal">
                Check your inbox. The link signs you in.
              </p>
            )}
          </div>
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              onClick={() => p.enabled && signIn(p.key)}
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
            Your handle is only used to receive payments. Bullet never posts or
            reads your account.
          </p>
        </div>
      )}

      {/* Step 2: attach a wallet */}
      {session && !linkedWallet && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl border border-fog bg-white px-4 py-3">
            <CheckIcon className="h-4 w-4 shrink-0 text-signal" />
            <span className="min-w-0 flex-1 truncate text-sm">
              Signed in as{" "}
              <span className="font-medium">{primaryHandle || "…"}</span>
            </span>
            <button
              onClick={signOut}
              className="shrink-0 text-xs text-graphite underline-offset-2 hover:text-ink hover:underline"
            >
              Sign out
            </button>
          </div>

          {handles.length > 1 && (
            <div className="space-y-1 rounded-xl border border-fog bg-white px-4 py-3 text-sm">
              {handles.map((h) => (
                <p
                  key={`${h.provider}:${h.handle}`}
                  className="flex items-center gap-2"
                >
                  <CheckIcon className="h-4 w-4 text-signal" />
                  <span className="text-graphite">
                    {providerLabel(h.provider)}
                  </span>
                  <span className="font-medium">{h.handle}</span>
                </p>
              ))}
            </div>
          )}

          {!address ? (
            <>
              <p className="text-sm text-graphite">
                Connect the Stellar wallet that will claim payments sent to{" "}
                <span className="text-ink">{primaryHandle || "you"}</span>.
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
      {session && linkedWallet && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-signal/30 bg-white p-5">
            <p className="flex items-center gap-2 font-semibold text-signal">
              <CheckIcon className="h-5 w-5" />
              {primaryHandle || "You"} can now get paid on Bullet
            </p>
            <p className="mt-1 text-sm text-graphite">
              Payments arrive as private notes in your inbox. Only the wallet{" "}
              <span className="font-mono">
                {linkedWallet.stellar_address.slice(0, 4)}…
                {linkedWallet.stellar_address.slice(-4)}
              </span>{" "}
              can claim them.
            </p>
          </div>

          <div className="rounded-2xl border border-fog bg-white p-5">
            <p className="text-sm font-medium">Handles that can receive payments</p>
            <p className="mt-1 text-xs text-graphite">
              Anyone sending to any of these lands in your inbox.
            </p>
            <div className="mt-3 space-y-1.5">
              {handles.map((h) => {
                const unlinkKey = `unlink:${h.provider}:${h.handle}`;
                const canUnlink = handles.length > 1;
                return (
                  <div
                    key={`${h.provider}:${h.handle}`}
                    className="flex items-center gap-2 text-sm"
                  >
                    <CheckIcon className="h-4 w-4 shrink-0 text-signal" />
                    <span className="text-graphite">
                      {providerLabel(h.provider)}
                    </span>
                    <span className="truncate font-medium">{h.handle}</span>
                    {canUnlink && (
                      <button
                        onClick={() => unlinkHandle(h.provider, h.handle ?? "")}
                        disabled={working !== ""}
                        className="ml-auto shrink-0 text-xs text-graphite underline-offset-2 hover:text-red-600 hover:underline disabled:opacity-50"
                      >
                        {working === unlinkKey ? "Removing…" : "Remove"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {(() => {
              const linked = new Set(handles.map((h) => h.provider));
              const missing = (
                [
                  { key: "google" as const, label: "Google" },
                  { key: "x" as const, label: "X (Twitter)" },
                ] as const
              ).filter(
                (p) =>
                  !(
                    linked.has(p.key) ||
                    (p.key === "x" &&
                      (linked.has("twitter") || linked.has("twitter_v2")))
                  )
              );
              const hasEmail = linked.has("email");
              if (missing.length === 0 && hasEmail) return null;
              return (
                <div className="mt-4 space-y-2 border-t border-fog pt-4">
                  <p className="text-xs text-graphite">Add another handle</p>
                  {missing.map((p) => (
                    <button
                      key={p.key}
                      onClick={() => linkProvider(p.key)}
                      disabled={working === "oauth"}
                      className="flex w-full items-center gap-2 rounded-full border border-fog bg-white px-4 py-2.5 text-sm font-medium transition-colors hover:border-graphite disabled:opacity-50"
                    >
                      {working === "oauth" ? (
                        <LoaderIcon className="h-4 w-4 animate-spin" />
                      ) : p.key === "google" ? (
                        <GoogleIcon className="h-4 w-4" />
                      ) : (
                        <XBrandIcon className="h-4 w-4" />
                      )}
                      Connect {p.label}
                    </button>
                  ))}
                  {!hasEmail && (
                    <div className="space-y-1.5 pt-1">
                      <div className="flex gap-2">
                        <input
                          type="email"
                          placeholder="you@example.com"
                          value={addEmail}
                          onChange={(e) => setAddEmail(e.target.value)}
                          onKeyDown={(e) => {
                            if (
                              e.key === "Enter" &&
                              addEmail.trim() &&
                              working !== "add_email"
                            )
                              addEmailIdentity();
                          }}
                          disabled={working === "add_email"}
                          className="w-full rounded-full border border-fog bg-white px-4 py-2 text-sm placeholder-graphite/60 focus:border-ink focus:outline-none disabled:opacity-50"
                        />
                        <button
                          onClick={addEmailIdentity}
                          disabled={working === "add_email" || !addEmail.trim()}
                          className="shrink-0 rounded-full border border-fog bg-white px-4 py-2 text-sm font-medium transition-colors hover:border-graphite disabled:opacity-40"
                        >
                          {working === "add_email" ? (
                            <LoaderIcon className="h-4 w-4 animate-spin" />
                          ) : (
                            "Add email"
                          )}
                        </button>
                      </div>
                      {addEmailSent && (
                        <p className="text-xs text-signal">
                          Check that inbox and click the confirmation link.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
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
            onClick={signOut}
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
