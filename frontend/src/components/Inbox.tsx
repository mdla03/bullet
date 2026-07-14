"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getMe, postActivity } from "@/lib/api";
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
  CheckIcon,
  ExternalLinkIcon,
  LoaderIcon,
  RefreshIcon,
  WalletIcon,
} from "@/components/icons";
import { Skeleton } from "@/components/Skeleton";

const PAGE_SIZE = 5;
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
  const [refreshing, setRefreshing] = useState(false);
  const [claims, setClaims] = useState<Record<string, ClaimStatus>>({});
  const [claimingAll, setClaimingAll] = useState(false);
  const [claimableShown, setClaimableShown] = useState(PAGE_SIZE);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) =>
      setSession(s)
    );
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function refresh() {
    if (!keys) return;
    setRefreshing(true);
    try {
      await loadNotes(keys, address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  }

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
  // Total claimable by token, formatted as "$50 USDC + 25 XLM".
  const totalsByToken: Record<number, number> = {};
  for (const n of claimable) {
    const tid = n.payload.tokenId ?? 0;
    totalsByToken[tid] = (totalsByToken[tid] ?? 0) + toStroops(n.payload);
  }
  const totalParts = Object.entries(totalsByToken).map(([tid, stroops]) => {
    const label = TOKEN_LABELS[Number(tid)] ?? "USDC";
    const units = stroops / 10_000_000;
    return [0, 2].includes(Number(tid)) ? `$${units} ${label}` : `${units} ${label}`;
  });

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-fog bg-white">
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            {totalParts.length === 0 ? (
              <p className="text-xl font-bold tracking-tight">
                0 <span className="text-sm font-medium text-graphite">claimable</span>
              </p>
            ) : (
              <>
                <div className="flex flex-col text-xl font-bold tracking-tight leading-tight">
                  {totalParts.map((p) => (
                    <span key={p}>{p}</span>
                  ))}
                </div>
                <p className="mt-1 text-xs font-medium text-graphite">claimable</p>
              </>
            )}
          </div>
          <button
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh"
            className="flex shrink-0 items-center justify-center rounded-full border border-fog p-2.5 text-graphite transition-colors hover:border-graphite hover:text-ink disabled:opacity-50"
          >
            <RefreshIcon className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>

        {notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 border-t border-fog p-8 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-paper">
              <ArrowDownLeftIcon className="h-5 w-5 text-graphite" />
            </div>
            <p className="font-medium">No claims yet</p>
          </div>
        ) : (
          <>
            {claimable.length >= 1 && (
              <div className="border-t border-fog px-4 py-3">
                <button
                  onClick={claimAll}
                  disabled={claimingAll}
                  className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-2.5 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
                >
                  {claimingAll ? (
                    <LoaderIcon className="h-5 w-5 animate-spin" />
                  ) : (
                    `Claim all (${claimable.length})`
                  )}
                </button>
              </div>
            )}
            <ul className="divide-y divide-fog border-t border-fog">
              {notes.slice(0, claimableShown).map((note) => {
                const status = claims[note.id];
                const claimed = !!note.claimedAt || status?.state === "done";
                const busy =
                  status &&
                  (status.state === "proving" ||
                    status.state === "signing" ||
                    status.state === "submitting");
                return (
                  <li key={note.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className={`text-base font-bold tracking-tight ${claimed ? "text-graphite" : ""}`}>
                        {formatNoteAmount(note.payload)}
                      </p>
                      <p className="text-xs text-graphite">
                        {timeAgo(note.createdAt)}
                        {note.payload.recipientHandle && (
                          <>
                            {" · "}
                            <span className={claimed ? "" : "text-ink"}>{note.payload.recipientHandle}</span>
                          </>
                        )}
                      </p>
                    </div>
                    {claimed ? (
                      <span className="flex items-center gap-1.5 text-xs font-medium text-signal">
                        <CheckIcon className="h-3.5 w-3.5" />
                        Claimed
                        {status?.state === "done" && (
                          <a
                            href={`https://stellar.expert/explorer/testnet/tx/${status.tx}`}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-1 text-graphite hover:text-ink"
                            aria-label="View claim on stellar.expert"
                          >
                            <ExternalLinkIcon className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </span>
                    ) : busy ? (
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
            {notes.length > claimableShown && (() => {
              const hiddenTotal = notes.length - claimableShown;
              const hiddenUnclaimed = notes
                .slice(claimableShown)
                .filter((n) => !n.claimedAt && claims[n.id]?.state !== "done").length;
              return (
                <button
                  onClick={() => setClaimableShown((n) => n + PAGE_SIZE)}
                  className="flex w-full items-center justify-center gap-2 border-t border-fog px-5 py-3 text-sm font-medium text-graphite transition-colors hover:bg-paper hover:text-ink"
                >
                  Show more ({hiddenTotal})
                  {hiddenUnclaimed > 0 && (
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[11px] font-semibold leading-none text-paper tabular-nums pt-px">
                      {hiddenUnclaimed}
                    </span>
                  )}
                </button>
              );
            })()}
          </>
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
