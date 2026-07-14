"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  GoogleIcon,
  LoaderIcon,
  MailIcon,
  TrashIcon,
  WalletIcon,
  XBrandIcon,
} from "@/components/icons";
import type { SVGProps } from "react";
import { createClient } from "@/lib/supabase/client";
import { getMe, type MeResponse } from "@/lib/api";

function providerIcon(provider: string): (p: SVGProps<SVGSVGElement>) => React.ReactElement {
  if (provider === "twitter" || provider === "twitter_v2" || provider === "x")
    return XBrandIcon;
  if (provider === "google") return GoogleIcon;
  return MailIcon;
}

export function AccountView() {
  const supabase = createClient();
  const router = useRouter();

  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [working, setWorking] = useState<string>("");
  const [addEmail, setAddEmail] = useState("");
  const [addEmailSent, setAddEmailSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState("");
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
  const linkedProviders = new Set(handles.map((h) => h.provider));
  const missingOAuth = (
    [
      { key: "google" as const, label: "Google", Icon: GoogleIcon },
      { key: "x" as const, label: "X", Icon: XBrandIcon },
    ] as const
  ).filter(
    (p) =>
      !(
        linkedProviders.has(p.key) ||
        (p.key === "x" &&
          (linkedProviders.has("twitter") || linkedProviders.has("twitter_v2")))
      )
  );
  const hasEmail = linkedProviders.has("email");

  return (
    <div className="space-y-4">
      <div className="space-y-4 rounded-2xl border border-fog bg-white p-6">
        <h2 className="text-xl font-bold tracking-tight">Handles</h2>
        <div className="space-y-2">
          {handles.map((h) => {
            const unlinkKey = `unlink:${h.provider}:${h.handle}`;
            const canUnlink = handles.length > 1;
            const Icon = providerIcon(h.provider);
            return (
              <div
                key={`${h.provider}:${h.handle}`}
                className="flex items-center gap-3 rounded-xl border border-fog px-4 py-3 text-sm"
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-medium">{h.handle}</span>
                {canUnlink && (() => {
                  const confirming = confirmingUnlink === unlinkKey;
                  const busy = working === unlinkKey;
                  return (
                    <button
                      onClick={() => {
                        if (busy) return;
                        if (confirming) {
                          setConfirmingUnlink("");
                          unlinkHandle(h.provider, h.handle ?? "");
                        } else {
                          setConfirmingUnlink(unlinkKey);
                          setTimeout(() => {
                            setConfirmingUnlink((prev) =>
                              prev === unlinkKey ? "" : prev
                            );
                          }, 3000);
                        }
                      }}
                      aria-label={confirming ? `Confirm removal of ${h.handle}` : `Remove ${h.handle}`}
                      className={`flex shrink-0 items-center justify-center rounded-full border p-2 transition-all ${
                        confirming
                          ? "border-red-300 bg-red-50 px-3 text-xs font-semibold text-red-600"
                          : "border-fog text-graphite hover:border-red-300 hover:text-red-600"
                      } ${busy ? "opacity-50" : ""}`}
                    >
                      {busy ? (
                        <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                      ) : confirming ? (
                        "Confirm?"
                      ) : (
                        <TrashIcon className="h-3.5 w-3.5" />
                      )}
                    </button>
                  );
                })()}
              </div>
            );
          })}
        </div>

        {(missingOAuth.length > 0 || !hasEmail) && (
          <div className="space-y-2 border-t border-fog pt-4">
            {missingOAuth.map((p) => (
              <button
                key={p.key}
                onClick={() => linkProvider(p.key)}
                disabled={working === "oauth"}
                className="flex w-full items-center justify-center gap-2 rounded-full border border-fog bg-white px-4 py-2.5 text-sm font-medium transition-colors hover:border-graphite disabled:opacity-50"
              >
                {working === "oauth" ? (
                  <LoaderIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <p.Icon className="h-4 w-4" />
                )}
                Connect {p.label}
              </button>
            ))}
            {!hasEmail && (
              <div className="space-y-2">
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
                  className="w-full rounded-xl border border-fog bg-white px-4 py-2.5 text-sm placeholder-graphite/70 focus:border-ink focus:outline-none disabled:opacity-50"
                />
                <button
                  onClick={addEmailIdentity}
                  disabled={working === "add_email" || !addEmail.trim()}
                  className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-4 py-2.5 text-sm font-medium transition-colors hover:border-graphite disabled:opacity-40"
                >
                  {working === "add_email" ? (
                    <LoaderIcon className="h-4 w-4 animate-spin" />
                  ) : (
                    "Add email"
                  )}
                </button>
                {addEmailSent && (
                  <p className="text-xs text-signal">
                    Check that inbox and click the confirmation link.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-2xl border border-fog bg-white p-6">
        <h2 className="text-xl font-bold tracking-tight">Wallet</h2>
        {linkedWallet ? (
          <>
            <div className="flex items-center gap-3 rounded-xl border border-fog px-4 py-3">
              <WalletIcon className="h-4 w-4 shrink-0 text-graphite" />
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {linkedWallet.stellar_address.slice(0, 6)}…
                {linkedWallet.stellar_address.slice(-6)}
              </span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(linkedWallet.stellar_address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                aria-label="Copy address"
                className="flex shrink-0 items-center justify-center rounded-full border border-fog p-2 text-graphite transition-colors hover:border-graphite hover:text-ink"
              >
                {copied ? (
                  <CheckIcon className="h-3.5 w-3.5 text-signal" />
                ) : (
                  <CopyIcon className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <a
              href={`https://stellar.expert/explorer/testnet/account/${linkedWallet.stellar_address}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-graphite hover:text-ink"
            >
              <ExternalLinkIcon className="h-3.5 w-3.5" />
              View on stellar.expert
            </a>
          </>
        ) : (
          <a
            href="/register"
            className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
          >
            Attach a wallet
          </a>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
