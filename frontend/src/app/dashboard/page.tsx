import * as StellarSdk from "@stellar/stellar-sdk";
import Link from "next/link";
import {
  enabledHandleTypes,
  handleTypeForCanonical,
  handleTypeForIdentityProvider,
} from "@zeekpay/shared";
import { createAdminClient, isAdminEmail } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  PAGE_SIZE,
  isStellarAddress,
  readFilters,
  type TxFilters,
} from "@/lib/dashboard_filters";
import DashboardStats from "@/components/DashboardStats";

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

/** A wallets row, as far as the wallet count needs it. `previous` holds every
 *  wallet this account switched away from (backend/sql/wallet_previous.sql). */
interface WalletRow {
  stellar_address: string | null;
  previous: { stellar_address?: string }[] | null;
}

/** Every handle type in registry order, so a platform with nothing yet still
 *  shows as a zero rather than vanishing. A missing row and a zero row mean
 *  very different things when the question is "does this platform work". */
/** Email is left out: it canonicalizes a bare address exactly as Google does,
 *  so its row restated Google's and always read zero sends. Links proven by
 *  email OTP are folded into Google below rather than dropped. */
const HANDLE_TYPES = enabledHandleTypes().filter((t) => t.id !== "email");

/** Counts per handle type, keyed by type id, starting at zero for all. */
function emptyByType(): Map<string, number> {
  return new Map(HANDLE_TYPES.map((t) => [t.id, 0]));
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
  const count = (table: string, col: string) =>
    db.from(table).select(col, { count: "exact", head: true });

  const [
    leaves,
    cursor,
    activity,
    profiles,
    wallets,
    unclaimed,
    invites,
    handles,
    activeWindow,
  ] = await Promise.all([
      count("merkle_leaves", "leaf_index"),
      db.from("merkle_state").select("cursor_ledger").eq("id", true).maybeSingle(),
      db
        .from("activity")
        .select("type, amount, token_id, tx_hash, created_at, user_id, handle")
        .order("created_at", { ascending: false })
        .limit(5000),
      count("profiles", "id"),
      // Current wallet plus every one switched away from (wallet_previous.sql
      // keeps them, since notes addressed to an old bullet_pubkey stay
      // claimable only by reconnecting that wallet). Counting rows would count
      // accounts holding a wallet right now, which silently drops every wallet
      // anyone has unlinked.
      db.from("wallets").select("stellar_address, previous").limit(10000),
      db.from("notes").select("id", { count: "exact", head: true }).is("claimed_at", null),
      count("pending_invites", "id"),
      // Provider only, never the handle itself: this page shows cross-user
      // aggregates, and a list of who is on what platform is not an aggregate.
      // ponytail: reads rows and counts here rather than grouping in SQL;
      // swap for an rpc if the handle count ever outgrows one page.
      db.from("handles").select("provider").limit(10000),
      // Active-user window. Queried separately from the activity read above
      // rather than derived from it: that one is capped at the 5000 most
      // recent rows overall, which would quietly understate a month once the
      // log outgrows it.
      db
        .from("activity")
        .select("user_id, created_at")
        .gte("created_at", new Date(Date.now() - MAU_DAYS * 86_400_000).toISOString())
        .limit(50000),
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
    if (!type) continue;
    // Email and Google are one address and one person, and the table shows one
    // row for them. Count an email-OTP link under Google rather than losing it.
    const id = type.id === "email" ? "google" : type.id;
    linkedHandles.set(id, (linkedHandles.get(id) ?? 0) + 1);
  }

  // Sends per recipient handle type. activity.handle is the recipient's
  // canonical handle on sends and null on claims, so this counts what was
  // actually paid at each platform: the thing D3 is judged on.
  //
  // Google and email share a canonical form (a bare address), and
  // handleTypeForCanonical returns the first type that claims it, which is
  // Google. Sends to an email address therefore count under Google. That is
  // the registry's own resolution order, the same one /resolve uses, so the
  // number matches the rest of the system rather than disagreeing with it.
  // The three namespaced D3 types are unambiguous and unaffected.
  const sendsByType = emptyByType();
  let sendsUnknownType = 0;
  for (const r of rows) {
    if (r.type !== "send" || !r.handle) continue;
    const type = handleTypeForCanonical(r.handle);
    if (!type) {
      sendsUnknownType += 1;
      continue;
    }
    const id = type.id === "email" ? "google" : type.id;
    sendsByType.set(id, (sendsByType.get(id) ?? 0) + 1);
  }

  // Every distinct wallet address the project has ever seen, current or since
  // replaced. Deduped because two accounts can legitimately name the same
  // address after a merge.
  const walletAddresses = new Set<string>();
  let walletsAttached = 0;
  for (const w of (wallets.data ?? []) as WalletRow[]) {
    if (w.stellar_address) {
      walletAddresses.add(w.stellar_address);
      walletsAttached += 1;
    }
    for (const prev of w.previous ?? []) {
      if (prev?.stellar_address) walletAddresses.add(prev.stellar_address);
    }
  }

  // Active = sent or claimed in the window. Rolling rather than calendar, so
  // the number does not reset to near-zero just after midnight UTC.
  const activeRows = (activeWindow.data ?? []) as { user_id: string; created_at: string }[];
  const dayAgo = Date.now() - 86_400_000;
  const dau = new Set(
    activeRows.filter((r) => Date.parse(r.created_at) >= dayAgo).map((r) => r.user_id)
  ).size;
  const mau = new Set(activeRows.map((r) => r.user_id)).size;

  return {
    deposits: leaves.count ?? 0,
    cursorLedger: cursor.data?.cursor_ledger ?? null,
    transactions: rows.length,
    sends: rows.filter((r) => r.type === "send").length,
    claims: rows.filter((r) => r.type === "claim").length,
    activeAccounts: new Set(rows.map((r) => r.user_id)).size,
    volume: [...volume.entries()].sort((a, b) => a[0] - b[0]),
    users: profiles.count ?? 0,
    walletsConnected: walletAddresses.size,
    walletsAttached,
    dau,
    mau,
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
  const ledger = await latestLedger();

  const header = (
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
    const { rows, total } = await loadTransactions(filters);
    return (
      <div className="space-y-8">
        {header}
        <TransactionsTab filters={filters} rows={rows} total={total} />
      </div>
    );
  }

  const m = await loadMetrics();
  const lag = ledger && m.cursorLedger ? ledger - m.cursorLedger : null;

  return (
    <div className="space-y-8">
      {header}

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
            label: "Deposits on-chain",
            value: m.deposits,
            note: "confirmed Merkle leaves",
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
        <label className="flex flex-col gap-1">
          <span className="text-xs text-graphite">Type</span>
          <select name="type" defaultValue={filters.type} className={field}>
            <option value="">All</option>
            <option value="send">Sends</option>
            <option value="claim">Claims</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-graphite">Asset</span>
          <select name="token" defaultValue={filters.token} className={field}>
            <option value="">All</option>
            {Object.entries(TOKENS).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
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
