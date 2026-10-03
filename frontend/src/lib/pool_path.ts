// Browser-side Merkle-path retrieval for pool spends, with the wait the
// indexer's two-step cadence forces on any client.
//
// A note is not spendable the instant its transaction confirms: the indexer
// first inserts the leaf (so /path starts answering) and then posts the root to
// the contract (so the proof against that root verifies). A spend attempted
// between those two steps fails with UnknownRoot. prove_browser.ts can call
// /path once because a claim's deposit has long since settled; a pool note
// created moments ago has not, so this polls until the note is actually
// spendable.

import * as StellarSdk from "@stellar/stellar-sdk";
import type { PoolPath } from "./pool_tx";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;
const RESOLVER_URL = process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decimal field element (as /path returns root) to 32-byte big-endian hex, the
 *  form the contract keys its root ring by. */
export function frHex(dec: string): string {
  const h = BigInt(dec).toString(16);
  if (h.length > 64) throw new Error(`field element overflow: ${dec}`);
  return h.padStart(64, "0");
}

/** The tree's current path for a commitment, or null until the indexer has
 *  inserted its leaf. */
export async function fetchPath(commitment: string): Promise<PoolPath | null> {
  const res = await fetch(
    `${RESOLVER_URL}/path?commitment=${encodeURIComponent(commitment)}`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/path returned HTTP ${res.status}`);
  return (await res.json()) as PoolPath;
}

/** Whether the contract already knows a root, by simulation (no fee, no
 *  signature). `rootHex` must be 32-byte big-endian hex, not the decimal /path
 *  returns. */
export async function isKnownRoot(rootHex: string, sourceAddress: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) {
    throw new Error(`isKnownRoot wants 64-char hex, got ${rootHex.slice(0, 24)}…`);
  }
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const op = new StellarSdk.Contract(CONTRACT_ID).call(
    "is_known_root",
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(rootHex, "hex"))
  );
  const account = await rpc.getAccount(sourceAddress);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await rpc.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`is_known_root simulation failed`);
  }
  return StellarSdk.scValToNative(sim.result.retval) === true;
}

/** Poll until a path exists for `commitment` AND the root it names is one the
 *  contract will accept, then return it. Both must hold at once, so this
 *  re-fetches rather than caching the first path it sees (the root advances as
 *  new leaves land). `onStatus` lets the UI show the wait; `timeoutMs` caps it. */
export async function waitForSpendablePath(
  commitment: string,
  sourceAddress: string,
  onStatus?: (label: string) => void,
  timeoutMs = 5 * 60_000
): Promise<PoolPath> {
  const started = Date.now();
  let announced = false;
  for (;;) {
    const path = await fetchPath(commitment);
    if (path && (await isKnownRoot(frHex(path.root), sourceAddress))) return path;
    if (Date.now() - started > timeoutMs) {
      throw new Error("the pool note is not spendable yet; the indexer has not posted its root");
    }
    if (!announced) {
      onStatus?.("Waiting for the note to settle");
      announced = true;
    }
    await sleep(6_000);
  }
}
