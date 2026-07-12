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

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;
const CONTRACT_ID = process.env.ZEEKPAY_CONTRACT_ID ?? "";
const ADMIN_KEY = process.env.ZEEKPAY_ADMIN_KEY ?? "";
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

/** Rebuild the in-memory tree from the durable Postgres store. Idempotent.
 *  Posts the current root on-chain so claims work immediately after restart. */
export async function hydrate(): Promise<void> {
  const all = await store.loadLeaves();
  leaves.clearAll();
  tree.rebuild();
  for (let i = 0; i < all.length; i++) {
    const idx = leaves.insert(all[i]);
    tree.onLeafInserted(all[i], idx);
  }
  hydrated = true;
  console.log(`[indexer] hydrated ${all.length} leaf(s) from Postgres`);
  if (all.length > 0) {
    try {
      await postRoot(tree.root());
      console.log("[indexer] root posted after hydration");
    } catch (e) {
      console.error("[indexer] post_root after hydration failed (non-fatal):", String(e).slice(0, 200));
    }
  }
}

/** One poll: fetch new deposit events since the cursor, insert confirmed
 *  leaves (in-memory + Postgres), post the root if anything changed, advance
 *  the cursor. Idempotent — duplicate events are dropped by dedupe. */
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
  let maxLedger = start - 1;
  for (const ev of res.events) {
    maxLedger = Math.max(maxLedger, ev.ledger);
    try {
      if (StellarSdk.scValToNative(ev.topic[0]) !== "deposit") continue;
      const data = StellarSdk.scValToNative(ev.value) as unknown[];
      const commitmentBytes = data[0] as Uint8Array;
      if (!(commitmentBytes instanceof Uint8Array) || commitmentBytes.length === 0)
        continue;
      const dec = bytesToDecimal(commitmentBytes);
      if (leaves.indexOf(dec) !== -1) continue; // already have it
      const leafIndex = leaves.insert(dec);
      tree.onLeafInserted(dec, leafIndex);
      await store.appendLeaf(leafIndex, dec); // durable write-through
      inserted += 1;
    } catch (e) {
      console.error("[indexer] skipped undecodable event:", String(e).slice(0, 200));
    }
  }

  if (inserted > 0) {
    await postRoot(tree.root());
  }
  // Advance cursor AFTER post_root succeeds so a failed root post retries
  // the same event range on the next poll instead of silently skipping it.
  await store.setCursor(res.events.length > 0 ? maxLedger : latest.sequence);
  return { inserted };
}

/** Publish the current tree root on-chain (admin/relayer). */
async function postRoot(rootDec: string): Promise<void> {
  if (!ADMIN_KEY) throw new Error("ZEEKPAY_ADMIN_KEY not set");
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const keypair = StellarSdk.Keypair.fromSecret(ADMIN_KEY);
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  const rootHex = BigInt(rootDec).toString(16).padStart(64, "0");
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
      if (inserted > 0) console.log(`[indexer] inserted ${inserted} new leaf(s); root posted`);
      else console.log(`[indexer] poll ok, 0 new leaves, ${leaves.count()} total`);
    } catch (e) {
      console.log("[indexer] poll error: " + String(e).slice(0, 400));
    } finally {
      timer = setTimeout(tick, POLL_MS);
    }
  };
  // Hydrate from Postgres first, then begin polling.
  hydrate()
    .catch((e) => console.error("[indexer] hydrate error:", String(e).slice(0, 400)))
    .finally(() => void tick());
  console.log(`[indexer] started; polling every ${POLL_MS}ms`);
}

export function stop(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
