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

/** Normalize legacy denom-format notes (denom: 1|10|50|100 USDC) to stroops. */
function toStroops(p: ClaimPayload): number {
  if (p.amount != null) return p.amount;
  return ((p as unknown as { denom?: number }).denom ?? 0) * 10_000_000;
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
  const [tab, setTab] = useState<"claimable" | "history">("claimable");
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [loadingActivity, setLoadingActivity] = useState(false);
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
      const { requestAccess, signMessage } = await import(
        "@stellar/freighter-api"
      );
      const res = await requestAccess();
      if ("error" in res && res.error) throw new Error(`Freighter: ${res.error}`);
      if (res.address !== wallet.stellar_address)
        throw new Error(
          `This isn't the wallet linked to your account. Switch Freighter to ${wallet.stellar_address.slice(0, 6)}…${wallet.stellar_address.slice(-6)} and try again.`
        );

      const sigRes = await signMessage(KEY_DOMAIN_MESSAGE, {
        address: res.address,
      });
      if (sigRes.error || !sigRes.signedMessage)
        throw new Error(
          `Freighter: ${sigRes.error?.message ?? "signature rejected"}`
        );
      const derived = deriveBulletKeys(signatureToHex(sigRes.signedMessage));
      if (derived.pubKeyHex !== wallet.bullet_pubkey)
        throw new Error(
          "This wallet's signature doesn't match your registered Bullet key."
        );

      setAddress(res.address);
      setKeys(derived);
      await loadNotes(derived, res.address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlocking(false);
    }
  }

  async function refresh() {
    if (!keys) return;
    setRefreshing(true);
    try {
      await loadNotes(keys, address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
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
        String(p.amount)
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
          BigInt(p.amount)
        );
      } else {
        const { signTransaction } = await import("@stellar/freighter-api");
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
            const signRes = await signTransaction(xdr, {
              networkPassphrase:
                process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ??
                "Test SDF Network ; September 2015",
            });
            if ("error" in signRes) throw new Error(`Freighter: ${signRes.error}`);
            return signRes.signedTxXdr;
          }
        );
      }

      set({ state: "done", tx: hash });
      markClaimed(note.id); // best-effort; the nullifier is the real record
      postActivity({ type: "claim", amount: toStroops(note.payload), txHash: hash });
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
      <div className="flex items-center gap-2 rounded-2xl border border-fog bg-white px-5 py-4 text-sm text-graphite">
        <LoaderIcon className="h-4 w-4 animate-spin" />
        Checking your session…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="space-y-4 rounded-2xl border border-fog bg-white px-6 py-8 text-center">
        <p className="font-medium">Your inbox lives behind your account.</p>
        <p className="text-sm text-graphite">
          Sign in to see the notes waiting for your handle.
        </p>
        <Link
          href="/register"
          className="inline-block rounded-full bg-ink px-6 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (!wallet) {
    return (
      <div className="space-y-4 rounded-2xl border border-fog bg-white px-6 py-8 text-center">
        <p className="font-medium">One step left: attach your wallet.</p>
        <p className="text-sm text-graphite">
          Your inbox is encrypted to keys derived from your wallet. Attach it
          once and your notes appear here.
        </p>
        <Link
          href="/register"
          className="inline-block rounded-full bg-ink px-6 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
        >
          Finish setup
        </Link>
      </div>
    );
  }

  if (!keys || !notes) {
    return (
      <div className="space-y-4">
        <div className="space-y-3 rounded-2xl border border-fog bg-white p-6">
          <p className="font-medium">Unlock your inbox</p>
          <p className="text-sm text-graphite">
            Notes are encrypted to keys only your wallet can re-derive. One
            Freighter signature unlocks them. Nothing is submitted on-chain
            and nothing is spent.
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
  const totalStroops = claimable.reduce((sum, n) => sum + toStroops(n.payload), 0);
  const total = totalStroops / 10_000_000;

  return (
    <div className="space-y-5">
      {/* Tab bar */}
      <div className="flex gap-1 rounded-full border border-fog bg-white p-1">
        {(["claimable", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              if (t === "history" && activity === null) loadActivity();
            }}
            className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? "bg-ink text-paper"
                : "text-graphite hover:text-ink"
            }`}
          >
            {t === "claimable" ? "Claimable" : "History"}
          </button>
        ))}
      </div>

      {/* Claimable tab */}
      {tab === "claimable" && (
        <>
          {/* Summary header */}
          <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-fog bg-white p-5">
            <div>
              <p className="text-4xl font-bold tracking-tight">
                ${total} <span className="text-2xl">USDC</span>
              </p>
              <p className="mt-1 text-sm text-graphite">
                claimable · {claimable.length}{" "}
                {claimable.length === 1 ? "note" : "notes"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={refresh}
                disabled={refreshing || claimingAll}
                className="text-xs text-graphite underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
              >
                {refreshing ? "Scanning…" : "Refresh"}
              </button>
              {claimable.length > 1 && (
                <button
                  onClick={claimAll}
                  disabled={claimingAll}
                  className="rounded-full bg-signal px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-signal/85 disabled:opacity-50"
                >
                  {claimingAll ? "Claiming…" : "Claim all"}
                </button>
              )}
            </div>
          </div>

          {/* Ledger */}
          {notes.length === 0 ? (
            <div className="rounded-2xl border border-fog bg-white px-6 py-10 text-center">
              <p className="font-medium">No notes yet.</p>
              <p className="mt-1 text-sm text-graphite">
                Payments sent to your handle will appear here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-fog rounded-2xl border border-fog bg-white">
              {notes.map((note) => {
                const status = claims[note.id];
                const claimed = !!note.claimedAt || status?.state === "done";
                const busy =
                  status &&
                  (status.state === "proving" ||
                    status.state === "signing" ||
                    status.state === "submitting");
                return (
                  <li
                    key={note.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-baseline gap-3">
                        <span
                          className={`text-lg font-bold tracking-tight ${claimed ? "text-graphite" : ""}`}
                        >
                          ${toStroops(note.payload) / 10_000_000} USDC
                        </span>
                        <span className="font-mono text-xs text-graphite">
                          note {note.id.slice(0, 4)}…
                        </span>
                      </p>
                      <p className="text-xs text-graphite">
                        received {timeAgo(note.createdAt)}
                        {note.payload.recipientHandle && (
                          <>
                            {" · sent to "}
                            <span className="text-ink">
                              {note.payload.recipientHandle}
                            </span>
                          </>
                        )}
                      </p>
                    </div>

                    {claimed ? (
                      <span className="flex items-center gap-1.5 text-sm font-medium text-signal">
                        <CheckIcon className="h-4 w-4" />
                        claimed
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
                      <span className="flex items-center gap-2 text-sm text-graphite">
                        <LoaderIcon className="h-4 w-4 animate-spin" />
                        {CLAIM_LABELS[status.state]}
                      </span>
                    ) : (
                      <button
                        onClick={() => claimOne(note)}
                        disabled={claimingAll}
                        className="rounded-full border border-fog bg-white px-4 py-1.5 text-sm font-semibold transition-colors hover:border-graphite disabled:opacity-50"
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
          )}

          <p className="text-xs text-graphite">
            Each claim is its own transaction with its own proof. Nothing on-chain
            connects a claim to the deposit that funded it.
          </p>
        </>
      )}

      {/* History tab */}
      {tab === "history" && (
        <>
          {loadingActivity ? (
            <div className="flex items-center gap-2 rounded-2xl border border-fog bg-white px-5 py-4 text-sm text-graphite">
              <LoaderIcon className="h-4 w-4 animate-spin" />
              Loading history…
            </div>
          ) : !activity || activity.length === 0 ? (
            <div className="rounded-2xl border border-fog bg-white px-6 py-10 text-center">
              <p className="font-medium">No activity yet.</p>
              <p className="mt-1 text-sm text-graphite">
                Sends and claims will appear here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-fog rounded-2xl border border-fog bg-white">
              {activity.map((item) => {
                const usdc = item.amount / 10_000_000;
                const isSend = item.type === "send";
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 px-5 py-4"
                  >
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
                        <span className="font-bold">${usdc} USDC</span>
                        {isSend && item.handle && (
                          <span className="text-graphite">
                            {" "}to {item.handle}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-graphite">
                        {timeAgo(item.created_at)}
                      </p>
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
