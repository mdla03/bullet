import * as StellarSdk from "@stellar/stellar-sdk";
import Link from "next/link";
import {
  enabledHandleTypes,
  handleTypeForCanonical,
  handleTypeForIdentityProvider,
} from "@zeekpay/shared";
import { createAdminClient, isAdminEmail } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Dashboard · bullet" };
export const dynamic = "force-dynamic";

const TOKENS: Record<number, string> = { 0: "USDC", 1: "XLM", 2: "USDT" };
const STROOPS = 10_000_000;
const DAYS = 14;

const NETWORK = (process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "").includes("Test")
  ? "testnet"
  : "public";
const explorerTx = (hash: string) =>
  `https://stellar.expert/explorer/${NETWORK}/tx/${hash}`;

interface ActivityRow {
  type: "send" | "claim";
  amount: number;
  token_id: number | null;
  tx_hash: string | null;
  created_at: string;
  user_id: string;
  handle: string | null;
}

/** Every handle type in registry order, so a platform with nothing yet still
 *  shows as a zero rather than vanishing. A missing row and a zero row mean
 *  very different things when the question is "does this platform work". */
const HANDLE_TYPES = enabledHandleTypes();

/** Counts per handle type, keyed by type id, starting at zero for all. */
function emptyByType(): Map<string, number> {
  return new Map(HANDLE_TYPES.map((t) => [t.id, 0]));
}

async function loadMetrics() {
  const db = createAdminClient();
  const count = (table: string, col: string) =>
    db.from(table).select(col, { count: "exact", head: true });

  const [leaves, cursor, activity, profiles, wallets, unclaimed, invites, ledger, handles] =
    await Promise.all([
      count("merkle_leaves", "leaf_index"),
      db.from("merkle_state").select("cursor_ledger").eq("id", true).maybeSingle(),
      db
        .from("activity")
        .select("type, amount, token_id, tx_hash, created_at, user_id, handle")
        .order("created_at", { ascending: false })
        .limit(5000),
      count("profiles", "id"),
      count("wallets", "user_id"),
      db.from("notes").select("id", { count: "exact", head: true }).is("claimed_at", null),
      count("pending_invites", "id"),
      latestLedger(),
      // Provider only, never the handle itself: this page shows cross-user
      // aggregates, and a list of who is on what platform is not an aggregate.
      // ponytail: reads rows and counts here rather than grouping in SQL;
      // swap for an rpc if the handle count ever outgrows one page.
      db.from("handles").select("provider").limit(10000),
    ]);

  const rows = (activity.data ?? []) as ActivityRow[];

  // Volume per asset, in whole units.
  const volume = new Map<number, number>();
  for (const r of rows) {
    const id = r.token_id ?? 0;
    volume.set(id, (volume.get(id) ?? 0) + r.amount / STROOPS);
  }

  // Last DAYS days of sends vs claims, oldest first.
  const today = new Date();
  const daily = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (DAYS - 1 - i));
    return { date: d.toISOString().slice(0, 10), sends: 0, claims: 0 };
  });
  const byDate = new Map(daily.map((d) => [d.date, d]));
  for (const r of rows) {
    const bucket = byDate.get(r.created_at.slice(0, 10));
    if (bucket) bucket[r.type === "claim" ? "claims" : "sends"] += 1;
  }

  // Linked handles per platform. Maps the raw auth.identities provider
  // ("twitter_v2", "github", …) through the registry rather than matching
  // strings here, so the three D3 platforms and X's three provider spellings
  // all land in the right bucket without a second list to keep in sync.
  const linkedHandles = emptyByType();
  for (const row of (handles.data ?? []) as { provider: string }[]) {
    const type = handleTypeForIdentityProvider(row.provider);
    if (type) linkedHandles.set(type.id, (linkedHandles.get(type.id) ?? 0) + 1);
  }

  // Sends per recipient handle type. activity.handle is the recipient's
  // canonical handle on sends and null on claims, so this counts what was
  // actually paid at each platform: the thing D3 is judged on.
  //
  // Google and email share a canonical form (a bare address), and
  // handleTypeForCanonical returns the first type that claims it, which is
  // Google. Sends to an email address therefore count under Google and the
  // email row stays at zero. That is the registry's own resolution order, the
  // same one /resolve uses, so the number matches the rest of the system
  // rather than disagreeing with it; the table says so underneath. The three
  // namespaced D3 types are unambiguous and unaffected.
  const sendsByType = emptyByType();
  let sendsUnknownType = 0;
  for (const r of rows) {
    if (r.type !== "send" || !r.handle) continue;
    const type = handleTypeForCanonical(r.handle);
    if (type) sendsByType.set(type.id, (sendsByType.get(type.id) ?? 0) + 1);
    else sendsUnknownType += 1;
  }

  return {
    deposits: leaves.count ?? 0,
    cursorLedger: cursor.data?.cursor_ledger ?? null,
    latestLedger: ledger,
    transactions: rows.length,
    sends: rows.filter((r) => r.type === "send").length,
    claims: rows.filter((r) => r.type === "claim").length,
    activeAccounts: new Set(rows.map((r) => r.user_id)).size,
    volume: [...volume.entries()].sort((a, b) => a[0] - b[0]),
    users: profiles.count ?? 0,
    linkedWallets: wallets.count ?? 0,
    unclaimedNotes: unclaimed.count ?? 0,
    pendingInvites: invites.count ?? 0,
    daily,
    linkedHandles,
    sendsByType,
    sendsUnknownType,
    recent: rows.filter((r) => r.tx_hash).slice(0, 15),
  };
}

async function latestLedger(): Promise<number | null> {
  const url = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
  if (!url) return null;
  try {
    const res = await new StellarSdk.rpc.Server(url).getLatestLedger();
    return res.sequence;
  } catch {
    return null; // RPC down is not a dashboard outage.
  }
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdminEmail(user?.email)) {
    return (
      <div className="mx-auto max-w-sm space-y-4 rounded-2xl border border-fog bg-white p-6">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-graphite">
          {user
            ? `Signed in as ${user.email}. This account is not on the admin list.`
            : "Sign in with an admin account to view metrics."}
        </p>
        <Link
          href="/register"
          className="inline-block rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper"
        >
          {user ? "Switch account" : "Sign in"}
        </Link>
      </div>
    );
  }

  const m = await loadMetrics();
  const lag =
    m.latestLedger && m.cursorLedger ? m.latestLedger - m.cursorLedger : null;

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="font-mono text-xs text-graphite">
          {NETWORK} · contract {process.env.NEXT_PUBLIC_CONTRACT_ID?.slice(0, 8)}…
          {m.latestLedger ? ` · ledger ${m.latestLedger.toLocaleString()}` : ""}
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Transactions"
          value={m.transactions}
          note={`${m.sends} sends · ${m.claims} claims`}
        />
        <Stat label="Deposits on-chain" value={m.deposits} note="confirmed Merkle leaves" />
        <Stat
          label="Active accounts"
          value={m.activeAccounts}
          note="sent or claimed at least once"
        />
        <Stat label="Unclaimed notes" value={m.unclaimedNotes} />
        <Stat label="Registered users" value={m.users} />
        <Stat label="Linked wallets" value={m.linkedWallets} note="wallet attached to account" />
        <Stat label="Pending invites" value={m.pendingInvites} />
        <Stat
          label="Indexer lag"
          value={lag === null ? "n/a" : `${lag} ledgers`}
          note={m.cursorLedger ? `cursor ${m.cursorLedger.toLocaleString()}` : "no cursor"}
        />
      </section>

      <section className="space-y-3 rounded-2xl border border-fog bg-white p-5">
        <h2 className="text-sm font-medium">Handles by platform</h2>
        <p className="text-xs text-graphite">
          Accounts linked, and sends paid to each. A platform with a linked
          handle but no sends has a proven login and no completed payment yet.
          Sends to a bare email address count under Google, which claims that
          form first in the registry, so the email row counts links only.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm">
            <thead>
              <tr className="border-b border-fog text-left text-xs text-graphite">
                <th className="py-2 font-medium">Platform</th>
                <th className="py-2 text-right font-medium">Linked</th>
                <th className="py-2 text-right font-medium">Sends</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {HANDLE_TYPES.map((t) => (
                <tr key={t.id} className="border-b border-fog/60 last:border-0">
                  <td className="py-2 font-sans">{t.label}</td>
                  <td className="py-2 text-right">{m.linkedHandles.get(t.id) ?? 0}</td>
                  <td className="py-2 text-right">{m.sendsByType.get(t.id) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {m.sendsUnknownType > 0 && (
          <p className="text-xs text-graphite">
            {m.sendsUnknownType} send
            {m.sendsUnknownType === 1 ? "" : "s"} to a handle the registry no
            longer recognises, from a type that has since been disabled.
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-2xl border border-fog bg-white p-5">
        <h2 className="text-sm font-medium">Volume by asset</h2>
        <div className="flex flex-wrap gap-8">
          {m.volume.length === 0 && <p className="text-sm text-graphite">No activity yet.</p>}
          {m.volume.map(([id, amount]) => (
            <div key={id}>
              <div className="text-2xl font-bold tracking-tight">
                {amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
              <div className="font-mono text-xs text-graphite">{TOKENS[id] ?? `token ${id}`}</div>
            </div>
          ))}
        </div>
      </section>

      <DailyChart data={m.daily} />

      <section className="space-y-3 rounded-2xl border border-fog bg-white p-5">
        <h2 className="text-sm font-medium">Recent transactions</h2>
        {m.recent.length === 0 ? (
          <p className="text-sm text-graphite">No transactions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="text-graphite">
                <tr>
                  <th className="py-2 pr-4 font-normal">Time (UTC)</th>
                  <th className="py-2 pr-4 font-normal">Type</th>
                  <th className="py-2 pr-4 font-normal">Amount</th>
                  <th className="py-2 font-normal">Tx</th>
                </tr>
              </thead>
              <tbody>
                {m.recent.map((r) => (
                  <tr key={r.tx_hash} className="border-t border-fog">
                    <td className="py-2 pr-4">{r.created_at.slice(0, 19).replace("T", " ")}</td>
                    <td className="py-2 pr-4">{r.type}</td>
                    <td className="py-2 pr-4">
                      {(r.amount / STROOPS).toLocaleString(undefined, {
                        maximumFractionDigits: 7,
                      })}{" "}
                      {TOKENS[r.token_id ?? 0] ?? r.token_id}
                    </td>
                    <td className="py-2">
                      <a
                        href={explorerTx(r.tx_hash!)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-signal hover:underline"
                      >
                        {r.tx_hash!.slice(0, 10)}…
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-xs text-graphite">
        Deposits come from the indexer, which only writes a leaf after a confirmed on-chain
        deposit event. Sends and claims are logged by the app when a transaction succeeds, so
        they can undercount a transaction sent outside the app.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: number | string;
  note?: string;
}) {
  return (
    <div className="rounded-2xl border border-fog bg-white p-4">
      <div className="text-2xl font-bold tracking-tight">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div className="mt-1 text-xs text-graphite">{label}</div>
      {note && <div className="font-mono text-[10px] text-graphite">{note}</div>}
    </div>
  );
}

/** Grouped bars, sends vs claims, one pair per day. Plain SVG: no chart
 *  library, no client JS. Native <title> tooltips carry the exact numbers. */
function DailyChart({ data }: { data: { date: string; sends: number; claims: number }[] }) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.sends, d.claims)));
  const w = 100 / data.length; // column width in %

  return (
    <section className="space-y-3 rounded-2xl border border-fog bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Daily transactions, last {DAYS} days</h2>
        <div className="flex items-center gap-4 text-xs text-graphite">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[1px] bg-ink" aria-hidden />
            Sends
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[1px] bg-signal" aria-hidden />
            Claims
          </span>
        </div>
      </div>

      <svg viewBox="0 0 100 34" className="h-40 w-full" preserveAspectRatio="none" role="img"
        aria-label={`Daily sends and claims for the last ${DAYS} days`}>
        {data.map((d, i) => {
          const x = i * w;
          const bar = (w - 2) / 2 - 0.4;
          return (
            <g key={d.date}>
              <rect
                x={x + 1}
                y={30 - (d.sends / max) * 28}
                width={bar}
                height={(d.sends / max) * 28}
                rx="0.6"
                className="fill-ink"
              >
                <title>{`${d.date}: ${d.sends} sends`}</title>
              </rect>
              <rect
                x={x + 1 + bar + 0.8}
                y={30 - (d.claims / max) * 28}
                width={bar}
                height={(d.claims / max) * 28}
                rx="0.6"
                className="fill-signal"
              >
                <title>{`${d.date}: ${d.claims} claims`}</title>
              </rect>
            </g>
          );
        })}
        <line x1="0" y1="30" x2="100" y2="30" className="stroke-fog" strokeWidth="0.3" />
      </svg>

      <div className="flex justify-between font-mono text-[10px] text-graphite">
        <span>{data[0]?.date}</span>
        <span>peak {max}/day</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </section>
  );
}
