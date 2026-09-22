"use client";

import { useEffect, useState } from "react";
import { getActivity, apiFetch, type ActivityItem } from "@/lib/api";
import { ArrowUpRightIcon, ExternalLinkIcon, MailIcon } from "@/components/icons";
import { Skeleton } from "@/components/Skeleton";

const PAGE_SIZE = 5;
const TOKEN_LABELS: Record<number, string> = { 0: "USDC", 1: "XLM", 2: "USDT" };

// GET /invites (backend/src/invite.ts listInvitesForSender) already excludes
// claimed rows, so everything here is still pending. handle/amount match the
// "to <handle>" / amount format of an ActivityItem, but there's no token_id:
// invites are USDC-only today (SendForm's expiry picker only shows for the
// invite path, which every token type can take, but nothing downstream of
// /invite/commit records which one — out of scope here, kept as-is).
interface InviteItem {
  id: string;
  handle: string;
  amount: number;
  expires_at: string;
  delivered_at: string | null;
  claimed_at: string | null;
  refunded_at: string | null;
  created_at: string;
}

type Row =
  | { kind: "send"; id: string; created_at: string; amount: number; token_id: number; handle: string | null; tx_hash: string | null }
  | { kind: "invite"; id: string; created_at: string; amount: number; handle: string; expires_at: string };

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  return new Date(iso).toLocaleDateString();
}

function untilExpiry(iso: string): string {
  const hours = (new Date(iso).getTime() - Date.now()) / 3_600_000;
  if (hours <= 0) return "expired";
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h until expiry`;
  return `${Math.ceil(hours / 24)}d until expiry`;
}

function normalizedHandle(h: string): string {
  return h.trim().toLowerCase().replace(/^@/, "");
}

/** Merge activity "send" rows with still-pending invites into one
 *  newest-first list. A pending invite already has its own "send" activity
 *  row (SendForm posts one right after the deposit tx), so without this a
 *  pending invite would show twice. Drop the plain send row that matches it
 *  (same handle + amount) and let the richer invite row stand in for it; a
 *  claimed invite has no match here (it fell out of GET /invites), so its
 *  original send row is left alone and reads as a normal send. */
// ponytail: dedupes an invite against its own send activity row by handle +
// amount, a heuristic that can misfire if two pending invites share both.
// The real fix is an invite_id column on the activity row, written at
// /invite/commit, so the two lists are disjoint by construction instead of
// reconciled here by guessing.
function mergeRows(sends: ActivityItem[], invites: InviteItem[]): Row[] {
  const pendingLeft = invites.map((inv) => ({
    inv,
    key: `${normalizedHandle(inv.handle)}::${inv.amount}`,
  }));
  const sendRows: Row[] = [];
  for (const s of sends) {
    const key = s.handle ? `${normalizedHandle(s.handle)}::${s.amount}` : null;
    const matchIdx = key ? pendingLeft.findIndex((p) => p.key === key) : -1;
    if (matchIdx !== -1) {
      pendingLeft.splice(matchIdx, 1); // represented by the invite row instead
      continue;
    }
    sendRows.push({
      kind: "send",
      id: s.id,
      created_at: s.created_at,
      amount: s.amount,
      token_id: s.token_id ?? 0,
      handle: s.handle,
      tx_hash: s.tx_hash,
    });
  }
  const inviteRows: Row[] = invites.map((inv) => ({
    kind: "invite",
    id: inv.id,
    created_at: inv.created_at,
    amount: inv.amount,
    handle: inv.handle,
    expires_at: inv.expires_at,
  }));
  return [...sendRows, ...inviteRows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export function SendHistory() {
  const [items, setItems] = useState<Row[] | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);

  useEffect(() => {
    const load = async () => {
      const [activity, invites] = await Promise.all([
        getActivity().catch(() => [] as ActivityItem[]),
        apiFetch("/invites")
          .then((r) => (r.ok ? r.json() : { items: [] }))
          .then((body: { items: InviteItem[] }) => body.items)
          .catch(() => [] as InviteItem[]),
      ]);
      setItems(mergeRows(activity.filter((r) => r.type === "send"), invites));
    };
    load();
    // Refetch when SendForm dispatches this after a successful send/invite.
    window.addEventListener("bullet:send-complete", load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("bullet:send-complete", load);
      window.removeEventListener("focus", load);
    };
  }, []);

  if (items === null) {
    return (
      <div className="space-y-3">
        <p className="px-1 text-sm font-medium text-graphite">Recent sends</p>
        <div className="space-y-2 rounded-2xl border border-fog bg-white p-4">
          <Skeleton className="h-10 rounded-md" />
          <Skeleton className="h-10 rounded-md" />
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="space-y-3">
        <p className="px-1 text-sm font-medium text-graphite">Recent sends</p>
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-fog bg-white p-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-paper">
            <ArrowUpRightIcon className="h-5 w-5 text-graphite" />
          </div>
          <p className="font-medium">No sends yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-1 text-sm font-medium text-graphite">Recent sends</p>
      <ul className="divide-y divide-fog rounded-2xl border border-fog bg-white">
        {items.slice(0, shown).map((item) => {
          const isInvite = item.kind === "invite";
          const units = item.amount / 10_000_000;
          const tid = item.kind === "send" ? item.token_id ?? 0 : 0;
          const label = TOKEN_LABELS[tid] ?? "USDC";
          const amt = isInvite || [0, 2].includes(tid) ? `$${units} ${label}` : `${units} ${label}`;
          const handle = item.handle;
          const meta = isInvite
            ? `${timeAgo(item.created_at)} · ${untilExpiry(item.expires_at)}`
            : timeAgo(item.created_at);
          return (
            <li key={`${item.kind}-${item.id}`} className="flex items-center gap-3 px-4 py-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper">
                {isInvite ? (
                  <MailIcon className="h-4 w-4 text-graphite" />
                ) : (
                  <ArrowUpRightIcon className="h-4 w-4 text-graphite" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-bold">{amt}</span>
                  {handle && <span className="text-graphite"> to {handle}</span>}
                </p>
                <p className="text-xs text-graphite">{meta}</p>
              </div>
              {item.kind === "send" && item.tx_hash && (
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
      {items.length > shown && (
        <button
          onClick={() => setShown((n) => n + PAGE_SIZE)}
          className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-5 py-2.5 text-sm font-medium text-graphite transition-colors hover:border-graphite hover:text-ink"
        >
          Show more ({items.length - shown})
        </button>
      )}
    </div>
  );
}
