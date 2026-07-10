"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { CheckIcon, LoaderIcon } from "@/components/icons";

interface Invite {
  id: string;
  handle: string;
  amount: number; // raw stroops
  expires_at: string;
  delivered_at: string | null;
  claimed_at: string | null;
  refunded_at: string | null;
  created_at: string;
}

function status(inv: Invite): { label: string; color: string } {
  if (inv.claimed_at) return { label: "claimed", color: "text-signal" };
  if (inv.refunded_at) return { label: "refunded", color: "text-graphite" };
  if (inv.delivered_at) return { label: "waiting to be claimed", color: "text-ink" };
  const now = Date.now();
  const exp = new Date(inv.expires_at).getTime();
  if (exp < now) return { label: "expired", color: "text-amber" };
  const daysLeft = Math.ceil((exp - now) / 86_400_000);
  return { label: `expires in ${daysLeft}d`, color: "text-graphite" };
}

export function SentInvites() {
  const [items, setItems] = useState<Invite[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/invites");
        if (!res.ok) throw new Error(`/invites failed (${res.status})`);
        const body = (await res.json()) as { items: Invite[] };
        setItems(body.items);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  if (error) return null; // silent: not signed in etc.
  if (!items) {
    return (
      <div className="flex items-center gap-2 text-xs text-graphite">
        <LoaderIcon className="h-3 w-3 animate-spin" />
        Loading sent invites…
      </div>
    );
  }
  if (items.length === 0) return null;

  return (
    <div className="rounded-2xl border border-fog bg-white p-5">
      <p className="text-sm font-medium">Sent invites</p>
      <p className="mt-1 text-xs text-graphite">
        Payments held until the recipient signs up. Refunds go back to your
        currently-linked wallet if they never do.
      </p>
      <div className="mt-3 divide-y divide-fog">
        {items.map((inv) => {
          const s = status(inv);
          return (
            <div
              key={inv.id}
              className="flex items-center gap-3 py-2.5 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                  <span className="font-bold">${inv.amount / 10_000_000}</span>
                  <span className="truncate text-graphite">to {inv.handle}</span>
                </p>
              </div>
              <span className={`shrink-0 text-xs ${s.color}`}>
                {inv.claimed_at && <CheckIcon className="mr-1 inline h-3.5 w-3.5" />}
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
