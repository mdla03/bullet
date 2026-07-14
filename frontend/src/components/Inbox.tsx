"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getMe, getActivity, postActivity, type ActivityItem } from "@/lib/api";
import { KEY_DOMAIN_MESSAGE, signatureToHex } from "@/lib/register";
import {
  deriveBulletKeys,
  fetchNotes,
  markClaimed,
  type BulletKeys,
  type InboxNote,
} from "@/lib/notes";
import { type ClaimPayload } from "@/lib/claim_link";
import { claimNote } from "@/lib/claim_tx";
import { isNullifierUsed, nullifierHexFromSecret } from "@/lib/nullifier";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  LoaderIcon,
  WalletIcon,
} from "@/components/icons";
import { Skeleton } from "@/components/Skeleton";

const PAGE_SIZE = 10;

const TABS = [
  { key: "claimable", label: "Claimable" },
  { key: "history", label: "History" },
] as const;
import { proveBrowser } from "@/lib/prove_browser";
import { claimInvite } from "@/lib/invite_claim";

interface WalletRow {
  stellar_address: string;
  bullet_pubkey: string;
}

type ClaimStatus =
  | { state: "proving" }
  | { state: "signing" }
  | { state: "submitting" }
  | { state: "done"; tx: string }
  | { state: "error"; message: string };

const CLAIM_LABELS: Record<string, string> = {
  proving: "Generating proof…",
  signing: "Sign in Freighter…",
  submitting: "Submitting…",
};

const TOKEN_LABELS: Record<number, string> = { 0: "USDC", 1: "XLM", 2: "USDT" };

/** Normalize legacy denom-format notes (denom: 1|10|50|100 USDC) to stroops. */
function toStroops(p: ClaimPayload): number {
  if (p.amount != null) return p.amount;
  return ((p as unknown as { denom?: number }).denom ?? 0) * 10_000_000;
}

function formatNoteAmount(p: ClaimPayload): string {
  const stroops = toStroops(p);
  const units = stroops / 10_000_000;
  const label = TOKEN_LABELS[p.tokenId ?? 0] ?? "USDC";
  return [0, 2].includes(p.tokenId ?? 0) ? `$${units} ${label}` : `${units} ${label}`;
}

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  return new Date(iso).toLocaleDateString();
}

export function Inbox() {
  const supabase = createClient();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [wallet, setWallet] = useState<WalletRow | null | undefined>(undefined);
  const [address, setAddress] = useState("");
  const [keys, setKeys] = useState<BulletKeys | null>(null);
  const [notes, setNotes] = useState<InboxNote[] | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [claims, setClaims] = useState<Record<string, ClaimStatus>>({});
  const [claimingAll, setClaimingAll] = useState(false);
  const [tab, setTab] = useState<"claimable" | "history">("claimable");
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [claimableShown, setClaimableShown] = useState(PAGE_SIZE);
  const [historyShown, setHistoryShown] = useState(PAGE_SIZE);
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
      setWallet(session === null ? null : undefined);
      return;
    }
    let cancelled = false;
    getMe()
      .then((me) => {
        if (!cancelled)
          setWallet(
            me.wallet
              ? {
                  stellar_address: me.wallet.stellar_address,
                  bullet_pubkey: me.wallet.bullet_pubkey,
                }
              : null
          );
      })
      .catch(() => {
        if (!cancelled) setWallet(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  async function unlock() {
    if (!wallet) return;
    setError("");
    setUnlocking(true);
    try {
      const { freighterRequestAccess, freighterSignMessage } = await import(
        "@/lib/freighter"
      );
      const { address: addr } = await freighterRequestAccess();
      if (addr !== wallet.stellar_address)
        throw new Error(
          `This isn't the wallet linked to your account. Switch Freighter to ${wallet.stellar_address.slice(0, 6)}…${wallet.stellar_address.slice(-6)} and try again.`
        );

      const signed = await freighterSignMessage(KEY_DOMAIN_MESSAGE, addr);
      const derived = deriveBulletKeys(signatureToHex(signed));
      if (derived.pubKeyHex !== wallet.bullet_pubkey)
        throw new Error(
          "This wallet's signature doesn't match your registered Bullet key."
        );

      setAddress(addr);
      setKeys(derived);
      await loadNotes(derived, addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlocking(false);
    }
  }

  // Re-scan notes when the tab comes back into focus. Cheaper than polling.
  useEffect(() => {
    if (!keys) return;
    const onFocus = () => {
      loadNotes(keys, address).catch((e) => {
        console.warn("[inbox] refresh on focus failed", e);
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, address]);

  // Fetch notes, then reconcile against the chain: a note whose nullifier is
  // already spent (e.g. claimed via its backup link) is stamped claimed so it
  // never shows a Claim button that would fail with NullifierUsed (#6).
  async function loadNotes(k: BulletKeys, source: string) {
    const list = await fetchNotes(k);
    const spent = await Promise.all(
      list.map(async (n) => {
        if (n.claimedAt) return false;
        try {
          return await isNullifierUsed(
            source,
            nullifierHexFromSecret(n.payload.secret)
          );
        } catch {
          return false; // chain read failed: leave claimable, submit will guard
        }
      })
    );
    const now = new Date().toISOString();
    setNotes(
      list.map((n, i) => {
        if (spent[i] && !n.claimedAt) {
          markClaimed(n.id); // best-effort DB catch-up
          return { ...n, claimedAt: now };
        }
        return n;
      })
    );
  }

  // A note is already claimed on-chain (backup link, or a prior tab). Reflect
  // it as claimed instead of surfacing the raw contract error.
  function markNoteSpent(id: string) {
    markClaimed(id); // best-effort DB catch-up
    setNotes((ns) =>
      ns
        ? ns.map((n) =>
            n.id === id
              ? { ...n, claimedAt: n.claimedAt ?? new Date().toISOString() }
              : n
          )
        : ns
    );
    setClaims((c) => {
      const next = { ...c };
      delete next[id];
      return next;
    });
  }

  async function claimOne(note: InboxNote): Promise<boolean> {
    const p = note.payload;
    const set = (status: ClaimStatus) =>
      setClaims((c) => ({ ...c, [note.id]: status }));

    try {
      set({ state: "proving" });
      const { proof_a, proof_b, proof_c, nullifier, root } = await proveBrowser(
        BigInt("0x" + p.secret).toString(),
        p.recipientDigest,
        String(p.amount),
        String(p.tokenId ?? 0)
      );

      set({ state: "signing" });
      let hash: string;
      if (note.inviteId && note.custodyStellarSecret) {
        // Invite: custody wallet claims + forwards to the user's real wallet
        // in one tx. No Freighter prompt needed.
        set({ state: "submitting" });
        const rdHexInv = BigInt(p.recipientDigest).toString(16).padStart(64, "0");
        hash = await claimInvite(
          note.custodyStellarSecret,
          address,
          proof_a,
          proof_b,
          proof_c,
          root,
          nullifier,
          rdHexInv,
          BigInt(p.amount),
          p.tokenId ?? 0
        );
      } else {
        const { freighterSignTransaction } = await import("@/lib/freighter");
        // Convert decimal recipientDigest to 32-byte big-endian hex for contract.
        const rdHex = BigInt(p.recipientDigest).toString(16).padStart(64, "0");
        hash = await claimNote(
          address,
          proof_a,
          proof_b,
          proof_c,
          root,
          nullifier,
          rdHex,
          BigInt(p.amount),
          async (xdr) => {
            set({ state: "submitting" });
            return freighterSignTransaction(
              xdr,
              process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015"
            );
          },
          p.tokenId ?? 0
        );
      }

      set({ state: "done", tx: hash });
      markClaimed(note.id); // best-effort; the nullifier is the real record
      postActivity({ type: "claim", amount: toStroops(note.payload), tokenId: p.tokenId ?? 0, txHash: hash });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Already spent (e.g. claimed via backup link). Not a real failure:
      // render it as claimed and let a "Claim all" queue keep going.
      if (/Error\(Contract, #6\)|NullifierUsed/i.test(msg)) {
        markNoteSpent(note.id);
        return true;
      }
      set({ state: "error", message: msg });
      return false;
    }
  }

  async function loadActivity() {
    setLoadingActivity(true);
    try {
      setActivity(await getActivity());
    } catch {
      setActivity([]);
    } finally {
      setLoadingActivity(false);
    }
  }

  async function claimAll() {
    if (!notes) return;
    setClaimingAll(true);
    for (const note of notes) {
      if (note.claimedAt || claims[note.id]?.state === "done") continue;
      const ok = await claimOne(note);
      if (!ok) break; // stop the queue on the first failure
    }
    setClaimingAll(false);
  }

  // ── render ──────────────────────────────────────────────────────────────

  if (session === undefined || (session && wallet === undefined)) {
    return (
      <div className="space-y-3 rounded-2xl border border-fog bg-white p-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-11 rounded-full" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="space-y-4 rounded-2xl border border-fog bg-white p-6">
        <h2 className="text-xl font-bold tracking-tight">Sign in to see your inbox</h2>
        <p className="text-sm text-graphite">
          Notes sent to your handle wait here until you claim them.
        </p>
        <Link
          href="/register"
          className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (!wallet) {
    return (
      <div className="space-y-4 rounded-2xl border border-fog bg-white p-6">
        <h2 className="text-xl font-bold tracking-tight">Attach a wallet</h2>
        <p className="text-sm text-graphite">
          Notes are encrypted to keys derived from your wallet.
        </p>
        <Link
          href="/register"
          className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
        >
          Finish setup
        </Link>
      </div>
    );
  }

  if (!keys || !notes) {
    return (
      <div className="space-y-4">
        <div className="space-y-4 rounded-2xl border border-fog bg-white p-6">
          <h2 className="text-xl font-bold tracking-tight">Unlock inbox</h2>
          <p className="text-sm text-graphite">
            One Freighter signature derives your reading keys. Nothing is
            submitted, nothing is spent.
          </p>
          <button
            onClick={unlock}
            disabled={unlocking}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
          >
            {unlocking ? (
              <LoaderIcon className="h-5 w-5 animate-spin" />
            ) : (
              <WalletIcon className="h-5 w-5" />
            )}
            {unlocking ? "Waiting for Freighter…" : "Unlock with Freighter"}
          </button>
        </div>
        {error && (
          <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }

  const claimable = notes.filter(
    (n) => !n.claimedAt && claims[n.id]?.state !== "done"
  );
  const tabIndex = TABS.findIndex((t) => t.key === tab);

  return (
    <div className="space-y-4">
      {/* Sliding tab bar (matches Send token toggle) */}
      <div className="relative flex rounded-full border border-fog bg-white p-1">
        <div
          className="absolute bottom-1 top-1 rounded-full bg-ink transition-[left] duration-300 ease-out"
          style={{
            width: `calc((100% - 8px) / ${TABS.length})`,
            left: `calc(4px + ${tabIndex} * (100% - 8px) / ${TABS.length})`,
          }}
          aria-hidden
        />
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              if (t.key === "history" && activity === null) loadActivity();
            }}
            className={`relative z-10 flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors duration-200 ${
              tab === t.key ? "text-paper" : "text-graphite hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "claimable" && (
        <>
          {claimable.length === 0 ? (
            <div className="rounded-2xl border border-fog bg-white p-8 text-center">
              <p className="font-medium">Nothing to claim</p>
              <p className="mt-1 text-sm text-graphite">
                New payments to your handle land here.
              </p>
            </div>
          ) : (
            <>
              {claimable.length > 1 && (
                <button
                  onClick={claimAll}
                  disabled={claimingAll}
                  className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
                >
                  {claimingAll ? (
                    <LoaderIcon className="h-5 w-5 animate-spin" />
                  ) : (
                    `Claim all (${claimable.length})`
                  )}
                </button>
              )}
              <ul className="divide-y divide-fog rounded-2xl border border-fog bg-white">
                {claimable.slice(0, claimableShown).map((note) => {
                  const status = claims[note.id];
                  const busy =
                    status &&
                    (status.state === "proving" ||
                      status.state === "signing" ||
                      status.state === "submitting");
                  return (
                    <li key={note.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-base font-bold tracking-tight">
                          {formatNoteAmount(note.payload)}
                        </p>
                        <p className="text-xs text-graphite">
                          {timeAgo(note.createdAt)}
                          {note.payload.recipientHandle && (
                            <>
                              {" · "}
                              <span className="text-ink">{note.payload.recipientHandle}</span>
                            </>
                          )}
                        </p>
                      </div>
                      {busy ? (
                        <span className="flex items-center gap-2 text-xs text-graphite">
                          <LoaderIcon className="h-4 w-4 animate-spin" />
                          {CLAIM_LABELS[status.state]}
                        </span>
                      ) : (
                        <button
                          onClick={() => claimOne(note)}
                          disabled={claimingAll}
                          className="rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
                        >
                          Claim
                        </button>
                      )}
                      {status?.state === "error" && (
                        <p className="w-full text-xs text-red-700">{status.message}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {claimable.length > claimableShown && (
                <button
                  onClick={() => setClaimableShown((n) => n + PAGE_SIZE)}
                  className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-5 py-2.5 text-sm font-medium text-graphite transition-colors hover:border-graphite hover:text-ink"
                >
                  Show more ({claimable.length - claimableShown})
                </button>
              )}
            </>
          )}
        </>
      )}

      {tab === "history" && (
        <>
          {loadingActivity || !activity ? (
            <div className="space-y-2 rounded-2xl border border-fog bg-white p-4">
              <Skeleton className="h-10 rounded-md" />
              <Skeleton className="h-10 rounded-md" />
              <Skeleton className="h-10 rounded-md" />
            </div>
          ) : activity.length === 0 ? (
            <div className="rounded-2xl border border-fog bg-white p-8 text-center">
              <p className="font-medium">No activity yet</p>
              <p className="mt-1 text-sm text-graphite">
                Sends and claims will appear here.
              </p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-fog rounded-2xl border border-fog bg-white">
                {activity.slice(0, historyShown).map((item) => {
                  const units = item.amount / 10_000_000;
                  const isSend = item.type === "send";
                  const tid = item.token_id ?? 0;
                  const label = TOKEN_LABELS[tid] ?? "USDC";
                  const amtLabel = [0, 2].includes(tid) ? `$${units} ${label}` : `${units} ${label}`;
                  return (
                    <li key={item.id} className="flex items-center gap-3 px-4 py-3">
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                          isSend ? "bg-paper" : "bg-signal/10"
                        }`}
                      >
                        {isSend ? (
                          <ArrowUpRightIcon className="h-4 w-4 text-graphite" />
                        ) : (
                          <ArrowDownLeftIcon className="h-4 w-4 text-signal" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {isSend ? "Sent" : "Claimed"}{" "}
                          <span className="font-bold">{amtLabel}</span>
                          {isSend && item.handle && (
                            <span className="text-graphite"> to {item.handle}</span>
                          )}
                        </p>
                        <p className="text-xs text-graphite">{timeAgo(item.created_at)}</p>
                      </div>
                      {item.tx_hash && (
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${item.tx_hash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-graphite hover:text-ink"
                          aria-label="View on stellar.expert"
                        >
                          <ExternalLinkIcon className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
              {activity.length > historyShown && (
                <button
                  onClick={() => setHistoryShown((n) => n + PAGE_SIZE)}
                  className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-5 py-2.5 text-sm font-medium text-graphite transition-colors hover:border-graphite hover:text-ink"
                >
                  Show more ({activity.length - historyShown})
                </button>
              )}
            </>
          )}
        </>
      )}

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
