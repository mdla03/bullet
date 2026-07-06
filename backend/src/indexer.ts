// Deposit indexer — the ONLY writer of the Merkle tree.
//
// SECURITY (C1): claim() pays out to anyone who proves membership under a
// contract-known root. That is only sound if every leaf in the tree
// corresponds to a real on-chain deposit. Previously the tree was filled by an
// open /commitment endpoint with no deposit check, so anyone could add a leaf
// and claim funds they never deposited (pool drain). This indexer closes that:
// it polls the contract's `deposit` events over Soroban RPC and inserts a leaf
// ONLY for a confirmed on-chain deposit, then posts the resulting root. No
// other code path may insert leaves or post roots.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as StellarSdk from "@stellar/stellar-sdk";
import * as leaves from "./leaves.js";
import * as tree from "./tree.js";

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;
const CONTRACT_ID = process.env.ZEEKPAY_CONTRACT_ID ?? "";
const ADMIN_KEY = process.env.ZEEKPAY_ADMIN_KEY ?? "";
const POLL_MS = parseInt(process.env.INDEXER_POLL_MS ?? "5000", 10);
// How far back to scan on a cold start (no cursor). Deposits older than this
// window at first boot must be backfilled manually via reprocessFrom().
const COLD_START_BACKFILL = parseInt(
  process.env.INDEXER_COLD_START_BACKFILL ?? "17280", // ~1 day of ledgers
  10
);

const DATA_DIR = path.join(fileURLToPath(import.meta.url), "../../data");
const CURSOR_FILE =
  process.env.INDEXER_CURSOR_OVERRIDE ??
  path.join(DATA_DIR, "indexer-cursor.json");

function loadCursor(): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8")) as {
      lastLedger?: number;
    };
    return typeof raw.lastLedger === "number" ? raw.lastLedger : null;
  } catch {
    return null;
  }
}

function saveCursor(lastLedger: number): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({ lastLedger }));
}

/** 32-byte big-endian commitment -> decimal Fr string (the leaf format). */
function bytesToDecimal(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return BigInt("0x" + (hex || "0")).toString();
}

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** One poll: fetch new deposit events since the cursor, insert confirmed
 *  leaves, post the root if anything changed, advance the cursor. Idempotent —
 *  duplicate events are dropped by leaves.insert()'s dedupe. */
export async function pollOnce(): Promise<{ inserted: number }> {
  if (!CONTRACT_ID) throw new Error("ZEEKPAY_CONTRACT_ID not set");
  const rpc = new StellarSdk.rpc.Server(RPC_URL);

  const latest = await rpc.getLatestLedger();
  let start = loadCursor();
  if (start == null) start = Math.max(1, latest.sequence - COLD_START_BACKFILL);
  else start = start + 1;

  if (start > latest.sequence) return { inserted: 0 }; // nothing new yet

  let res: StellarSdk.rpc.Api.GetEventsResponse;
  try {
    res = await rpc.getEvents({
      startLedger: start,
      filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
      limit: 200,
    });
  } catch (e) {
    // Most common cause: the cursor fell outside the RPC retention window.
    // Clamp forward to the latest ledger so we resume from live traffic rather
    // than looping on an un-servable range. Older deposits need reprocessFrom().
    console.error("[indexer] getEvents failed, clamping cursor:", String(e).slice(0, 300));
    saveCursor(latest.sequence);
    return { inserted: 0 };
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
      const existed = leaves.indexOf(dec) !== -1;
      const leafIndex = leaves.insert(dec);
      if (!existed) {
        tree.onLeafInserted(dec, leafIndex);
        inserted += 1;
      }
    } catch (e) {
      console.error("[indexer] skipped undecodable event:", String(e).slice(0, 200));
    }
  }

  // Advance the cursor past everything we scanned. When the page had events we
  // trust maxLedger; otherwise jump to latest so we don't rescan empty ranges.
  saveCursor(res.events.length > 0 ? maxLedger : latest.sequence);

  if (inserted > 0) {
    await postRoot(tree.root());
  }
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

/** Force a rescan from a specific ledger (manual backfill / recovery). */
export async function reprocessFrom(ledger: number): Promise<{ inserted: number }> {
  saveCursor(ledger - 1);
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
    } catch (e) {
      console.error("[indexer] poll error:", String(e).slice(0, 400));
    } finally {
      timer = setTimeout(tick, POLL_MS);
    }
  };
  void tick();
  console.log(`[indexer] started; polling every ${POLL_MS}ms`);
}

export function stop(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
