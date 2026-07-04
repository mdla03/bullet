// Read-only check of a note's on-chain nullifier status.
//
// A note's nullifier = Poseidon([secret]) — the same value the claim proof
// binds. Once ANY claim path spends it (inbox claim OR a backup claim link),
// the contract records the nullifier and rejects every later claim with
// Error::NullifierUsed (#6). The inbox uses this to render already-spent notes
// as claimed instead of offering a Claim button that would fail on submit.
//
// The secret never leaves the browser: we compute the nullifier locally and
// only send that 32-byte hash to the contract's read-only getter.

import * as StellarSdk from "@stellar/stellar-sdk";
import { poseidon } from "./poseidon";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;

/** Poseidon([secret]) as 32-byte big-endian hex. Mirrors prove_browser.ts. */
export function nullifierHexFromSecret(secretHex: string): string {
  const secretDec = BigInt("0x" + secretHex).toString();
  const dec = poseidon([secretDec]);
  const h = BigInt(dec).toString(16);
  if (h.length > 64) throw new Error(`nullifier overflow: ${dec}`);
  return h.padStart(64, "0");
}

/**
 * Ask the contract whether this nullifier has been spent. Read-only: builds a
 * throwaway invocation of is_nullifier_used and simulates it (no signature, no
 * fee, no submission). `sourceAddress` only funds the simulated tx envelope;
 * any existing account works.
 */
export async function isNullifierUsed(
  sourceAddress: string,
  nullifierHex: string
): Promise<boolean> {
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const { xdr } = StellarSdk;

  const op = contract.call(
    "is_nullifier_used",
    xdr.ScVal.scvBytes(Buffer.from(nullifierHex, "hex"))
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
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  const retval = sim.result?.retval;
  return retval ? StellarSdk.scValToNative(retval) === true : false;
}
