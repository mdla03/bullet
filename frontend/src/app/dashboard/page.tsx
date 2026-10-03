import * as StellarSdk from "@stellar/stellar-sdk";
import Link from "next/link";
import { createAdminClient, isAdminEmail } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  PAGE_SIZE,
  isStellarAddress,
  readFilters,
  type TxFilters,
} from "@/lib/dashboard_filters";
import {
  HANDLE_TYPES,
  mapMetrics,
  type RawMetrics,
} from "@/lib/dashboard_metrics";
import DashboardStats from "@/components/DashboardStats";
import Segmented from "@/components/Segmented";

export const metadata = { title: "Dashboard · bullet" };
export const dynamic = "force-dynamic";

const TOKENS: Record<number, string> = { 0: "USDC", 1: "XLM", 2: "USDT" };
const STROOPS = 10_000_000;
const DAYS = 14;
/** Window for the monthly-active count, and for the activity read behind both
 *  active-user figures. */
const MAU_DAYS = 30;

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

/** Accounts that have ever held this wallet address, current or since
 *  switched away from. Returns [] when nobody has, which the caller turns into
 *  an empty result rather than an unfiltered one. */
async function accountsForWallet(address: string): Promise<string[]> {
  const db = createAdminClient();
  const { data } = await db
    .from("wallets")
    .select("user_id")
    // Address is base32-only by isStellarAddress, so it cannot break out of
    // the filter string. `previous` carries the wallets an account switched
    // away from (backend/sql/wallet_previous.sql), matched by containment
    // against the gin index that note delivery already uses.
    .or(`stellar_address.eq.${address},previous.cs.[{"stellar_address":"${address}"}]`)
    .limit(100);
  return (data ?? []).map((w) => (w as { user_id: string }).user_id);
}

async function loadTransactions(f: TxFilters) {
  const db = createAdminClient();
  // A wallet address names an account, so it filters by user_id and catches
  // that account's claims too. Every other term is matched against the
  // recipient handle and the tx hash, and `handle` is null on claims, so a
  // handle search is a search of sends by construction.
  const walletAccounts = isStellarAddress(f.q) ? await accountsForWallet(f.q) : null;
  if (walletAccounts?.length === 0) return { rows: [] as ActivityRow[], total: 0 };

  let q = db
    .from("activity")
    .select("type, amount, token_id, tx_hash, created_at, user_id, handle", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range(f.page * PAGE_SIZE, f.page * PAGE_SIZE + PAGE_SIZE - 1);

  if (f.type) q = q.eq("type", f.type);
  if (f.token) q = q.eq("token_id", Number(f.token));
  if (f.from) q = q.gte("created_at", `${f.from}T00:00:00.000Z`);
  // Inclusive of the whole end day, which is what a date picker implies.
  if (f.to) q = q.lte("created_at", `${f.to}T23:59:59.999Z`);
  if (walletAccounts) q = q.in("user_id", walletAccounts);
  else if (f.q) q = q.or(`handle.ilike.%${f.q}%,tx_hash.ilike.%${f.q}%`);

  const { data, count } = await q;
  return { rows: (data ?? []) as ActivityRow[], total: count ?? 0 };
}

async function loadMetrics() {
  const db = createAdminClient();
  // One round trip, aggregated in Postgres (backend/sql/dashboard_metrics.sql).
  // This used to pull 5000 activity rows, 10000 wallets and 50000 more activity
  // rows and count them here, which also capped three of the figures at "within
  // the most recent 5000 rows" rather than what their labels claim.
  const { data, error } = await db.rpc("dashboard_metrics", {
    days: DAYS,
    mau_days: MAU_DAYS,
  });
  if (error) throw new Error(`dashboard_metrics: ${error.message}`);
  return mapMetrics(data as unknown as RawMetrics);
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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  const sp = await searchParams;
  const tab = sp.tab === "transactions" ? "transactions" : "overview";
  // The ledger read is a Soroban RPC round trip, 0.4s on a good day and 1.5s
  // on a cold one. It has to race the database work, never precede it: it was
  // inside loadMetrics' Promise.all before the tabs split it out, and awaiting
  // it here first put that latency in front of every query on both tabs.
  const ledgerPromise = latestLedger();

  const header = (ledger: number | null) => (
    <>
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="font-mono text-xs text-graphite">
          {NETWORK} · contract {process.env.NEXT_PUBLIC_CONTRACT_ID?.slice(0, 8)}…
          {ledger ? ` · ledger ${ledger.toLocaleString()}` : ""}
        </p>
      </header>
      <Tabs active={tab} />
    </>
  );

  if (tab === "transactions") {
    const filters = readFilters(sp);
    const [ledger, { rows, total }] = await Promise.all([
      ledgerPromise,
      loadTransactions(filters),
    ]);
    return (
      <div className="space-y-8">
        {header(ledger)}
        <TransactionsTab filters={filters} rows={rows} total={total} />
      </div>
    );
  }

  const [ledger, m] = await Promise.all([ledgerPromise, loadMetrics()]);
  const lag = ledger && m.cursorLedger ? ledger - m.cursorLedger : null;

  return (
    <div className="space-y-8">
      {header(ledger)}

      <DashboardStats
        stats={[
          {
            id: "transactions",
            label: "Transactions",
            value: m.transactions,
            note: `${m.sends} sends · ${m.claims} claims`,
          },
          {
            id: "deposits",
            label: "Notes on-chain",
            value: m.deposits,
            note: "Merkle leaves: deposits and pool outputs",
          },
          {
            id: "active-accounts",
            label: "Active accounts",
            value: m.activeAccounts,
            note: "sent or claimed at least once",
          },
          { id: "unclaimed-notes", label: "Unclaimed notes", value: m.unclaimedNotes },
          { id: "users", label: "Registered users", value: m.users },
          {
            id: "wallets",
            label: "Wallets connected",
            value: m.walletsConnected,
            note: `unique, incl. unlinked · ${m.walletsAttached} attached now`,
          },
          {
            id: "dau",
            label: "Daily active users",
            value: m.dau,
            note: "sent or claimed in 24h",
          },
          {
            id: "mau",
            label: "Monthly active users",
            value: m.mau,
            note: `sent or claimed in ${MAU_DAYS}d`,
          },
          { id: "pending-invites", label: "Pending invites", value: m.pendingInvites },
          {
            id: "indexer-lag",
            label: "Indexer lag",
            value: lag === null ? "n/a" : `${lag} ledgers`,
            note: m.cursorLedger ? `cursor ${m.cursorLedger.toLocaleString()}` : "no cursor",
          },
        ]}
      />

      <p className="text-xs text-graphite">
        Two different things are counted here. Transactions, volume and the
        active-account figures come from what the app recorded as users acted in
        it. Notes on-chain comes from the contract&apos;s own events. The second
        can exceed the first, and usually does: a claim taken through a claim
        link records nothing, and anything transacted against the contract
        directly is on-chain without ever passing through the app. Read the
        chain as the authority on what happened, and these counts as the
        authority on what happened <em>in the app</em>.
      </p>

      <section className="space-y-3 rounded-2xl border border-fog bg-white p-5">
        <h2 className="text-sm font-medium">Handles by platform</h2>
        <p className="text-xs text-graphite">
          Accounts linked, and sends paid to each. A platform with a linked
          handle but no sends has a proven login and no completed payment yet.
          Google covers bare email addresses too, both the sends paid to them
          and the accounts that signed in with an email code.
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
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Recent transactions</h2>
          <Link
            href="/dashboard?tab=transactions"
            className="text-xs text-signal hover:underline"
          >
            View all
          </Link>
        </div>
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

function Tabs({ active }: { active: "overview" | "transactions" }) {
  const tabs = [
    { id: "overview", label: "Overview", href: "/dashboard" },
    { id: "transactions", label: "Transactions", href: "/dashboard?tab=transactions" },
  ];
  return (
    <nav className="flex gap-2">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          aria-current={active === t.id ? "page" : undefined}
          className={`rounded-full px-4 py-1.5 text-sm font-medium ${
            active === t.id
              ? "bg-ink text-paper"
              : "border border-fog bg-white text-graphite hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Full activity log with filters. A plain GET form: the query string is the
 *  filter state, so a filtered view is a link someone can keep, and the page
 *  needs no client JS to do any of it. */
function TransactionsTab({
  filters,
  rows,
  total,
}: {
  filters: TxFilters;
  rows: ActivityRow[];
  total: number;
}) {
  const start = filters.page * PAGE_SIZE;
  const pageLink = (page: number) => {
    const qs = new URLSearchParams({ tab: "transactions" });
    if (filters.type) qs.set("type", filters.type);
    if (filters.token) qs.set("token", filters.token);
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    if (filters.q) qs.set("q", filters.q);
    if (page > 0) qs.set("page", String(page));
    return `/dashboard?${qs}`;
  };
  const field =
    "rounded-xl border border-fog bg-white px-3 py-2 text-sm focus:border-ink focus:outline-none";

  return (
    <section className="space-y-4 rounded-2xl border border-fog bg-white p-5">
      <form method="get" action="/dashboard" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="tab" value="transactions" />
        <Segmented
          name="type"
          label="Type"
          value={filters.type}
          options={[
            { value: "", label: "All" },
            { value: "send", label: "Sends" },
            { value: "claim", label: "Claims" },
          ]}
        />
        <Segmented
          name="token"
          label="Asset"
          value={filters.token}
          options={[
            { value: "", label: "All" },
            ...Object.entries(TOKENS).map(([id, name]) => ({ value: id, label: name })),
          ]}
        />
        <label className="flex flex-col gap-1">
          <span className="text-xs text-graphite">From</span>
          <input type="date" name="from" defaultValue={filters.from} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-graphite">To</span>
          <input type="date" name="to" defaultValue={filters.to} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-graphite">Handle, wallet or tx hash</span>
          <input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="@name, G… or hash"
            className={`${field} font-mono`}
          />
        </label>
        <button
          type="submit"
          className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper"
        >
          Apply
        </button>
        <Link
          href="/dashboard?tab=transactions"
          className="rounded-full border border-fog px-5 py-2 text-sm font-medium text-graphite hover:text-ink"
        >
          Reset
        </Link>
      </form>

      <p className="text-xs text-graphite">
        {total.toLocaleString()} transaction{total === 1 ? "" : "s"} match
        {total === 1 ? "es" : ""}
        {rows.length > 0 && total > PAGE_SIZE
          ? ` · showing ${(start + 1).toLocaleString()}–${(start + rows.length).toLocaleString()}`
          : ""}
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-graphite">No transactions match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead className="text-graphite">
              <tr>
                <th className="py-2 pr-4 font-normal">Time (UTC)</th>
                <th className="py-2 pr-4 font-normal">Type</th>
                <th className="py-2 pr-4 font-normal">Amount</th>
                <th className="py-2 pr-4 font-normal">Recipient</th>
                <th className="py-2 font-normal">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.created_at}-${r.tx_hash ?? r.user_id}`} className="border-t border-fog">
                  <td className="py-2 pr-4">{r.created_at.slice(0, 19).replace("T", " ")}</td>
                  <td className="py-2 pr-4">{r.type}</td>
                  <td className="py-2 pr-4">
                    {(r.amount / STROOPS).toLocaleString(undefined, {
                      maximumFractionDigits: 7,
                    })}{" "}
                    {TOKENS[r.token_id ?? 0] ?? r.token_id}
                  </td>
                  <td className="py-2 pr-4">{r.handle ?? "n/a"}</td>
                  <td className="py-2">
                    {r.tx_hash ? (
                      <a
                        href={explorerTx(r.tx_hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-signal hover:underline"
                      >
                        {r.tx_hash.slice(0, 10)}…
                      </a>
                    ) : (
                      "n/a"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs">
          {filters.page > 0 ? (
            <Link href={pageLink(filters.page - 1)} className="text-signal hover:underline">
              Previous
            </Link>
          ) : (
            <span className="text-graphite">Previous</span>
          )}
          <span className="font-mono text-graphite">
            page {filters.page + 1} of {Math.ceil(total / PAGE_SIZE)}
          </span>
          {start + rows.length < total ? (
            <Link href={pageLink(filters.page + 1)} className="text-signal hover:underline">
              Next
            </Link>
          ) : (
            <span className="text-graphite">Next</span>
          )}
        </div>
      )}
    </section>
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
