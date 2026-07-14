"use client";

import { useEffect, useState } from "react";
import { getActivity, type ActivityItem } from "@/lib/api";
import { ArrowUpRightIcon, ExternalLinkIcon } from "@/components/icons";
import { Skeleton } from "@/components/Skeleton";

const PAGE_SIZE = 5;
const TOKEN_LABELS: Record<number, string> = { 0: "USDC", 1: "XLM", 2: "USDT" };

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  return new Date(iso).toLocaleDateString();
}

export function SendHistory() {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);

  useEffect(() => {
    const load = () => {
      getActivity()
        .then((rows) => setItems(rows.filter((r) => r.type === "send")))
        .catch(() => setItems([]));
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
          const units = item.amount / 10_000_000;
          const tid = item.token_id ?? 0;
          const label = TOKEN_LABELS[tid] ?? "USDC";
          const amt = [0, 2].includes(tid) ? `$${units} ${label}` : `${units} ${label}`;
          return (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper">
                <ArrowUpRightIcon className="h-4 w-4 text-graphite" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-bold">{amt}</span>
                  {item.handle && <span className="text-graphite"> to {item.handle}</span>}
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
