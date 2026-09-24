// Deposit indexer — the ONLY writer of the Merkle tree.
//
// SECURITY (C1): claim() pays out to anyone who proves membership under a
// contract-known root. That is only sound if every leaf in the tree
// corresponds to a real on-chain deposit. This indexer inserts a leaf ONLY for
// a confirmed on-chain `deposit` event, then posts the resulting root.
//
// DURABILITY: leaves + ledger cursor live in Postgres (merkle_store), NOT on
// local disk. An ephemeral host (Railway) wipes local files on redeploy, which
// previously desynced the tree and made deposited notes unclaimable. On boot we
// hydrate the in-memory tree from Postgres and write every new leaf through to
// it, so restarts/redeploys can't lose the tree.

import * as StellarSdk from "@stellar/stellar-sdk";
import * as leaves from "./leaves.js";
import * as tree from "./tree.js";
import * as store from "./merkle_store.js";
import { RPC_URL, CONTRACT_ID, ADMIN_KEY } from "./chain_config.js";
import { decimalToHex32, simulateBoolView } from "./chain_view.js";

const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;
const POLL_MS = parseInt(process.env.INDEXER_POLL_MS ?? "5000", 10);
// First ledger to scan when the DB has no cursor yet (fresh deploy). Set this
// to around the contract's creation ledger so the very first run backfills all
// historic deposits (bounded by RPC event retention). Falls back to a ~1-day
// look-back if unset.
const START_LEDGER = parseInt(process.env.INDEXER_START_LEDGER ?? "0", 10);
const COLD_START_BACKFILL = parseInt(
  process.env.INDEXER_COLD_START_BACKFILL ?? "17280", // ~1 day of ledgers
  10
);

/** 32-byte big-endian commitment -> decimal Fr string (the leaf format). */
function bytesToDecimal(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return BigInt("0x" + (hex || "0")).toString();
}

let running = false;
let hydrated = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Rebuild the in-memory tree from Postgres. Idempotent. Leaves go back to
 *  their stored leafIndex, not their position in the result, so a gap stays
 *  a gap instead of shifting every later leaf. */
export async function hydrate(): Promise<void> {
  const all = await store.loadLeaves();
  leaves.clearAll();
  for (const { leafIndex, commitment } of all) leaves.setAt(leafIndex, commitment);
  leaves.flush();
  tree.rebuild();
  hydrated = true;
  console.log(`[indexer] hydrated ${all.length} leaf(s) from Postgres`);
}

// Pages followed per poll. Each getEvents request scans a bounded ledger
// window (about 10k ledgers on the public testnet RPC) and returns a cursor to
// continue from, so a backfill takes several pages even when most are empty.
const MAX_PAGES = parseInt(process.env.INDEXER_MAX_PAGES ?? "50", 10);
const PAGE_LIMIT = 200;
// Leaf indices accepted as permanently missing (deposits older than RPC event
// retention that were never indexed). Their notes stay unclaimable; any other
// gap blocks post_root. Comma-separated, e.g. "0,1".
const LOST_LEAVES = new Set(
  (process.env.INDEXER_LOST_LEAVES ?? "")
    .split(",")
    .filter((x) => x.trim() !== "")
    .map((x) => parseInt(x, 10))
);

/** Ledger encoded in an RPC event cursor ("<toid>-<n>", ledger = toid >> 32). */
function cursorLedger(cursor: string): number {
  return Number(BigInt(cursor.split("-")[0]) >> 32n);
}

/** One poll: page through events since the cursor and post the root if it
 *  matches the chain. Idempotent: re-seen events are no-ops. */
export async function pollOnce(): Promise<{ inserted: number }> {
  if (!CONTRACT_ID) throw new Error("ZEEKPAY_CONTRACT_ID not set");
  if (!hydrated) await hydrate();
  const rpc = new StellarSdk.rpc.Server(RPC_URL);

  const latest = await rpc.getLatestLedger();
  const cursor = await store.getCursor();
  let start: number;
  if (cursor == null) {
    start = START_LEDGER > 0 ? START_LEDGER : Math.max(1, latest.sequence - COLD_START_BACKFILL);
  } else {
    start = cursor + 1;
  }
  if (start > latest.sequence) return { inserted: 0 }; // nothing new yet

  const filters = [{ type: "contract" as const, contractIds: [CONTRACT_ID] }];
  let res: StellarSdk.rpc.Api.GetEventsResponse;
  try {
    res = await rpc.getEvents({ startLedger: start, filters, limit: 200 });
  } catch (e) {
    // Usually: `start` is below the RPC's event-retention window. Do NOT jump
    // the cursor forward to latest — that silently skips every deposit between
    // `start` and now. Instead clamp UP to the oldest retained ledger and retry
    // from there, so we index as much history as the RPC still holds. Deposits
    // older than retention are unfetchable via RPC (recover them from Postgres,
    // already the source of truth, or a manual reindex from a retained ledger).
    console.warn("[indexer] getEvents failed; clamping up to oldest retained:", String(e).slice(0, 200));
    try {
      const probe = await rpc.getEvents({ startLedger: latest.sequence, filters, limit: 1 });
      const retryStart = Math.max(start, probe.oldestLedger);
      res = await rpc.getEvents({ startLedger: retryStart, filters, limit: 200 });
      console.warn(`[indexer] resumed from oldest retained ledger ${retryStart}`);
    } catch (e2) {
      // Still failing (RPC hiccup, etc.). Leave the cursor untouched so the
      // next poll retries the same range rather than skipping it.
      console.error("[indexer] getEvents retry failed; cursor unchanged:", String(e2).slice(0, 200));
      return { inserted: 0 };
    }
  }

  let inserted = 0;
  for (let page = 1; ; page++) {
    // Decode this page's leaves first; write order (Postgres, then the disk
    // cache) is applied once below instead of per event.
    const pageLeaves = new Map<number, string>();
    for (const ev of res.events) {
      try {
        // `note` (transact outputs) takes contract indices exactly like
        // `deposit`, so both must land in the tree or it gaps.
        const kind = StellarSdk.scValToNative(ev.topic[0]);
        if (kind !== "deposit" && kind !== "note") continue;
        const data = StellarSdk.scValToNative(ev.value) as unknown[];
        const commitmentBytes = data[0] as Uint8Array;
        const leafIndex = Number(data[1]); // the contract's own index
        if (!(commitmentBytes instanceof Uint8Array) || commitmentBytes.length === 0)
          continue;
        if (!Number.isSafeInteger(leafIndex) || leafIndex < 0) continue;
        const dec = bytesToDecimal(commitmentBytes);
        const have = leaves.at(leafIndex) ?? pageLeaves.get(leafIndex);
        if (have === dec) continue; // already have it
        if (have !== undefined)
          console.warn(`[indexer] leaf ${leafIndex} held a different commitment; replacing it with the on-chain one`);
        pageLeaves.set(leafIndex, dec);
        inserted += 1;
      } catch (e) {
        console.error("[indexer] skipped undecodable event:", String(e).slice(0, 200));
      }
    }
    if (pageLeaves.size > 0) {
      const batch = [...pageLeaves].map(([leafIndex, commitment]) => ({ leafIndex, commitment }));
      await store.appendLeaves(batch); // durable write-through, before the disk cache
      for (const { leafIndex, commitment } of batch) {
        leaves.setAt(leafIndex, commitment);
        tree.onLeafInserted(commitment, leafIndex);
      }
      leaves.flush(); // one disk write per page, not one per leaf
    }
    // This page's leaves are stored, so its ledgers are done. A full page's
    // cursor can point mid-ledger, so stop one ledger short and let the
    // already-have check absorb the re-scan.
    const scanned = Math.min(cursorLedger(res.cursor) - 1, res.latestLedger);
    if (scanned >= start) await store.setCursor(scanned);
    const caughtUp =
      res.events.length < PAGE_LIMIT && cursorLedger(res.cursor) >= res.latestLedger;
    if (caughtUp || page >= MAX_PAGES) break;
    res = await rpc.getEvents({ cursor: res.cursor, filters, limit: PAGE_LIMIT });
  }

  await maybePostRoot(rpc);
  return { inserted };
}

/** Read a u32/u64 unit variant (e.g. DataKey::Index) from instance storage. */
async function readInstanceNumber(rpc: StellarSdk.rpc.Server, variant: string): Promise<number> {
  const entry = await rpc.getContractData(
    CONTRACT_ID,
    StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
    StellarSdk.rpc.Durability.Persistent
  );
  for (const e of entry.val.contractData().val().instance().storage() ?? []) {
    const k = StellarSdk.scValToNative(e.key()) as unknown[];
    if (Array.isArray(k) && k[0] === variant) return Number(StellarSdk.scValToNative(e.val()));
  }
  throw new Error(`contract instance has no ${variant}`);
}

/** Read-only: does the contract know this root? Simulated (never signed or
 *  sent) the same way invite.ts checks is_nullifier_used, via the contract's
 *  public is_known_root view, instead of reading its internal DataKey::Root
 *  storage layout directly. */
async function isKnownRoot(rpc: StellarSdk.rpc.Server, rootDec: string): Promise<boolean> {
  if (!ADMIN_KEY) throw new Error("ZEEKPAY_ADMIN_KEY not set");
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const account = await rpc.getAccount(StellarSdk.Keypair.fromSecret(ADMIN_KEY).publicKey());
  const rootHex = decimalToHex32(rootDec);
  return simulateBoolView(
    rpc,
    contract,
    account,
    NETWORK_PASSPHRASE,
    "is_known_root",
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(rootHex, "hex"))
  );
}

/** Post the root only when the tree provably matches the chain (no holes, and
 *  count == contract Index): a root over a wrong tree strands every note
 *  placed after the error. Skips the tx when the root is already on-chain. */
async function maybePostRoot(rpc: StellarSdk.rpc.Server): Promise<void> {
  const chainIndex = await readInstanceNumber(rpc, "Index");
  const holes = leaves.missing().filter((i) => !LOST_LEAVES.has(i));
  if (leaves.count() !== chainIndex || holes.length > 0) {
    console.error(
      `[indexer] RECONCILE MISMATCH: tree has ${leaves.count()} slot(s), contract Index is ${chainIndex}, ` +
        `missing leaves [${holes.slice(0, 20).join(",")}${holes.length > 20 ? ",..." : ""}]. Not posting a root.`
    );
    return;
  }
  const root = tree.root();
  if (await isKnownRoot(rpc, root)) return;
  await postRoot(root);
  console.log(`[indexer] root posted over ${chainIndex} leaf slot(s)`);
}

/** Publish the current tree root on-chain (admin/relayer). */
async function postRoot(rootDec: string): Promise<void> {
  if (!ADMIN_KEY) throw new Error("ZEEKPAY_ADMIN_KEY not set");
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const keypair = StellarSdk.Keypair.fromSecret(ADMIN_KEY);
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  const rootHex = decimalToHex32(rootDec);
  const rootVal = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(rootHex, "hex"));
  const op = contract.call("post_root", rootVal);

  const account = await rpc.getAccount(keypair.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);
  const sent = await rpc.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`post_root sendTransaction: ${JSON.stringify(sent.errorResult)}`);
  }
  const final = await rpc.pollTransaction(sent.hash, { attempts: 20 });
  if (final.status !== "SUCCESS") throw new Error(`post_root tx ${final.status}`);
}

/** Force a rescan from a specific ledger (manual backfill / recovery). Re-inserts
 *  any deposits missing from the tree; dedupe makes it safe to re-run. */
export async function reprocessFrom(ledger: number): Promise<{ inserted: number }> {
  if (!hydrated) await hydrate();
  await store.setCursor(Math.max(0, ledger - 1));
  return pollOnce();
}

/** Start the background poll loop. Safe to call once at server boot. */
export function start(): void {
  if (running) return;
  if (!CONTRACT_ID || !ADMIN_KEY) {
    console.warn("[indexer] disabled: ZEEKPAY_CONTRACT_ID or ZEEKPAY_ADMIN_KEY not set");
    return;
  }
  running = true;
  const tick = async () => {
    try {
      const { inserted } = await pollOnce();
      if (inserted > 0) console.log(`[indexer] inserted ${inserted} new leaf(s)`);
      else console.log(`[indexer] poll ok, 0 new leaves, ${leaves.count()} total`);
    } catch (e) {
      console.log("[indexer] poll error: " + String(e).slice(0, 400));
    } finally {
      timer = setTimeout(tick, POLL_MS);
    }
  };
  // Hydrate from Postgres first, then begin polling.
  // If REINDEX_ON_BOOT=1, reset cursor to START_LEDGER so the first poll
  // rescans from the beginning — no admin token needed.
  (async () => {
      if (process.env.REINDEX_ON_BOOT === "1") {
        console.log("[indexer] REINDEX_ON_BOOT: clearing Postgres tree + cursor");
        await store.clearAll();
        const from = START_LEDGER > 0 ? START_LEDGER : 1;
        console.log(`[indexer] REINDEX_ON_BOOT: will rescan from ledger ${from}`);
        hydrated = false;
      }
      await hydrate();
    })()
    .catch((e) => console.error("[indexer] hydrate error:", String(e).slice(0, 400)))
    .finally(() => void tick());
  console.log(`[indexer] started; polling every ${POLL_MS}ms`);
}

export function stop(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
