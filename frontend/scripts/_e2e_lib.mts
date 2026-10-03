// Shared plumbing for the testnet validation harnesses (e2e_cycles.mts,
// pool_hidden_amount.mts). Nothing here is app code: it is the Freighter
// substitute, the waits that the indexer's two-step leaf-then-root cadence
// forces on any client, and the Soroban argument encoders the app's own libs
// already do for the entry points they cover.

import * as StellarSdk from "@stellar/stellar-sdk";

export const RESOLVER_URL = process.env.NEXT_PUBLIC_RESOLVER_URL!;
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID!;
export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a network call through transient failures. The waits in this file poll
 *  hosted services for minutes at a time, so a single dropped connection or a
 *  cold container must not end a run that has already moved value on-chain.
 *  Only the attempt is retried; nothing here is a state change. */
export async function retry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 6
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`    ${label} failed (${msg}), retry ${i + 1}/${attempts} in 15s`);
      await sleep(15_000);
    }
  }
  throw last;
}

export function keypairFromEnv(name: string): StellarSdk.Keypair {
  const secret = process.env[name];
  if (!secret) throw new Error(`${name} is required`);
  return StellarSdk.Keypair.fromSecret(secret);
}

/** Stands in for Freighter: signs the prepared XDR with a local keypair. */
export function localSigner(kp: StellarSdk.Keypair) {
  return async (xdr: string): Promise<string> => {
    const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
    tx.sign(kp);
    return tx.toXDR();
  };
}

export interface Resolved {
  stellarAddress: string;
  zeekPayPubKey: string;
  type?: string;
}

export async function resolveHandle(handle: string): Promise<Resolved> {
  return retry("/resolve", async () => {
  const res = await fetch(`${RESOLVER_URL}/resolve?q=${encodeURIComponent(handle)}`);
  const body = (await res.json()) as Resolved & { found?: boolean };
  if (!res.ok || !body.found) {
    throw new Error(`resolve ${handle} failed: HTTP ${res.status}`);
  }
  if (!body.zeekPayPubKey) {
    throw new Error(`resolve ${handle} returned no published key`);
  }
  return body;
  });
}

export interface MerklePath {
  root: string;
  pathElements: string[];
  pathIndices: number[];
}

/** The tree's current path for a commitment, or null until the indexer has
 *  inserted its leaf. */
export async function fetchPath(commitment: string): Promise<MerklePath | null> {
  return retry("/path", async () => {
    const res = await fetch(
      `${RESOLVER_URL}/path?commitment=${encodeURIComponent(commitment)}`
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`/path returned HTTP ${res.status}`);
    return (await res.json()) as MerklePath;
  });
}

/** Block until the deployed indexer has inserted a commitment's leaf. Until
 *  that happens there is nothing to prove membership against. */
export async function waitForLeaf(
  commitment: string,
  timeoutMs = 10 * 60_000
): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await fetchPath(commitment)) return Math.round((Date.now() - started) / 1000);
    if (Date.now() - started > timeoutMs) {
      throw new Error(`leaf for ${commitment} never indexed`);
    }
    await sleep(10_000);
  }
}

/** Whether the contract already knows a root, by simulation (no fee, no
 *  signature). The indexer inserts a leaf and posts the resulting root as two
 *  separate steps, so a path fetched immediately after a deposit names a root
 *  that is not yet on-chain. Spending against it fails with UnknownRoot
 *  (error #5), and retrying the same proof cannot recover: by then the indexer
 *  may have advanced to a newer root and this one will never be posted. */
/** `rootHex` must be the 32-byte big-endian hex form, not the decimal field
 *  element `/path` returns. Passing a decimal string here parses as hex, yields
 *  the wrong length, and the contract traps rather than answering. */
export async function isKnownRoot(
  rootHex: string,
  sourceAccount: string
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(rootHex)) {
    throw new Error(`isKnownRoot wants 64-char hex, got ${rootHex.slice(0, 24)}…`);
  }
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const op = new StellarSdk.Contract(CONTRACT_ID).call(
    "is_known_root",
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(rootHex, "hex"))
  );
  const account = await rpc.getAccount(sourceAccount);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await retry("is_known_root", () => rpc.simulateTransaction(tx));
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`is_known_root simulation failed: ${JSON.stringify(sim)}`);
  }
  return StellarSdk.scValToNative(sim.result.retval) === true;
}

/** Wait until a path exists for `commitment` AND the root it names is one the
 *  contract will accept, then return it. Both conditions have to hold at the
 *  same time, so this re-fetches rather than caching the first path it sees. */
export async function waitForSpendablePath(
  commitment: string,
  sourceAccount: string,
  timeoutMs = 10 * 60_000
): Promise<MerklePath> {
  const started = Date.now();
  for (;;) {
    const path = await fetchPath(commitment);
    // `/path` names the root as a decimal field element; the contract keys its
    // root ring by the 32-byte big-endian form.
    if (path && (await isKnownRoot(fr(path.root), sourceAccount))) return path;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no posted root ever covered ${commitment}`);
    }
    await sleep(10_000);
  }
}

/** Build, prepare, sign and submit a contract call, polling to confirmation.
 *  Mirrors what lib/deposit.ts and lib/claim_tx.ts do for the entry points
 *  they cover; `transact` has no app-side wrapper yet. */
export async function invoke(
  source: StellarSdk.Keypair,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<string> {
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const op = new StellarSdk.Contract(CONTRACT_ID).call(method, ...args);
  const account = await rpc.getAccount(source.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "2000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(source);
  const sent = await rpc.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${method} rejected: ${JSON.stringify(sent.errorResult)}`);
  }
  const final = await rpc.pollTransaction(sent.hash, { attempts: 30 });
  if (final.status !== "SUCCESS") {
    throw new Error(`${method} ended with status ${final.status}`);
  }
  return sent.hash;
}

// ── Groth16 byte layout for Soroban ─────────────────────────────────────────
// Same encoding lib/prove_browser.ts produces for `claim`: G1 = BE(X)||BE(Y),
// G2 with the Fp2 coefficients swapped to c1-before-c0, Fr big-endian.

const be = (dec: string, bytes: number): string => {
  const h = BigInt(dec).toString(16);
  if (h.length > bytes * 2) throw new Error(`value overflow: ${dec}`);
  return h.padStart(bytes * 2, "0");
};

export const g1 = (pt: [string, string, string]): string => be(pt[0], 48) + be(pt[1], 48);
export const g2 = (
  pt: [[string, string], [string, string], [string, string]]
): string => be(pt[0][1], 48) + be(pt[0][0], 48) + be(pt[1][1], 48) + be(pt[1][0], 48);
export const fr = (dec: string): string => be(dec, 32);

export const bytesVal = (hex: string) =>
  StellarSdk.xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
