"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import {
  CheckIcon,
  GoogleIcon,
  LoaderIcon,
  WalletIcon,
  XBrandIcon,
} from "@/components/icons";
import { createClient } from "@/lib/supabase/client";
import { getMe, type MeResponse } from "@/lib/api";

type Tab = "handles" | "wallet";

function providerLabel(provider: string): string {
  if (provider === "twitter" || provider === "twitter_v2" || provider === "x")
    return "X";
  if (provider === "email") return "Email";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function AccountView() {
  const supabase = createClient();
  const router = useRouter();

  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [tab, setTab] = useState<Tab>("handles");
  const [working, setWorking] = useState<string>("");
  const [addEmail, setAddEmail] = useState("");
  const [addEmailSent, setAddEmailSent] = useState(false);
  const [error, setError] = useState("");

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
    else if (session === null) router.replace("/register");
  }, [session, refreshMe, router]);

  async function linkProvider(provider: "google" | "x") {
    setError("");
    setWorking("oauth");
    const { error: err } = await supabase.auth.linkIdentity({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (err) {
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
      const identities = data?.identities ?? [];
      const identity = identities.find((i) => {
        if (i.provider !== provider) return false;
        const d = i.identity_data as Record<string, unknown> | undefined;
        if (!d) return false;
        return d.email === handle || d.user_name === handle ||
          d.preferred_username === handle;
      }) ?? identities.find((i) => i.provider === provider);
      if (!identity) throw new Error("Identity not found for this handle");
      if (identities.length <= 1)
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

  if (session === undefined) {
    return (
      <div className="flex items-center gap-2 text-sm text-graphite">
        <LoaderIcon className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (!session || !me) return null;

  const linkedWallet = me.wallet ?? null;
  const handles = me.identities ?? [];

  const tabs: { key: Tab; label: string }[] = [
    { key: "handles", label: "Handles" },
    { key: "wallet", label: "Wallet" },
  ];

  return (
    <div className="space-y-6">
      {/* Tab bar */}
      <div className="flex gap-1 rounded-full border border-fog bg-white p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setError(""); }}
            className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-ink text-paper"
                : "text-graphite hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Handles tab */}
      {tab === "handles" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-fog bg-white p-5">
            <p className="text-sm font-medium">Connected handles</p>
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
        </div>
      )}

      {/* Wallet tab */}
      {tab === "wallet" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-fog bg-white p-5">
            <p className="text-sm font-medium">Connected wallet</p>
            {linkedWallet ? (
              <div className="mt-3 flex items-center gap-3">
                <WalletIcon className="h-5 w-5 text-graphite" />
                <span className="font-mono text-sm">
                  {linkedWallet.stellar_address.slice(0, 6)}…
                  {linkedWallet.stellar_address.slice(-6)}
                </span>
                <CheckIcon className="ml-auto h-4 w-4 text-signal" />
              </div>
            ) : (
              <p className="mt-3 text-sm text-graphite">
                No wallet linked yet.{" "}
                <a
                  href="/register"
                  className="text-ink underline underline-offset-2 hover:no-underline"
                >
                  Complete setup
                </a>{" "}
                to connect one.
              </p>
            )}
          </div>
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
