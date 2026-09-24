// Read-only Soroban contract views + Fr (BLS12-381 scalar field) <-> hex
// encoding, shared by indexer.ts (is_known_root) and invite.ts
// (is_nullifier_used, nullifier hex). Kept out of both call sites so
// indexer.ts doesn't have to import invite.ts's Supabase-backed
// invite-delivery code just to reuse a few lines.

import * as StellarSdk from "@stellar/stellar-sdk";

/** Decimal Fr string -> 32-byte big-endian hex, zero-padded. Throws if the
 *  value doesn't fit in 32 bytes (64 hex chars) instead of silently
 *  truncating or padding wrong. */
export function decimalToHex32(dec: string): string {
  const h = BigInt(dec).toString(16);
  if (h.length > 64) throw new Error(`decimalToHex32: value overflows 32 bytes: ${dec}`);
  return h.padStart(64, "0");
}

/** Build `method(...args)`, simulate it (never signed or sent) against
 *  `account`, and read back a bool retval. Shared by invite.ts's
 *  is_nullifier_used check and indexer.ts's is_known_root check — both are
 *  public bool-returning Soroban views read the same way. */
export async function simulateBoolView(
  rpc: StellarSdk.rpc.Server,
  contract: StellarSdk.Contract,
  account: StellarSdk.Account,
  networkPassphrase: string,
  method: string,
  ...args: StellarSdk.xdr.ScVal[]
): Promise<boolean> {
  const op = contract.call(method, ...args);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  const retval = sim.result?.retval;
  return retval ? StellarSdk.scValToNative(retval) === true : false;
}
