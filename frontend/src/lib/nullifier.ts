// Read-only check of a note's on-chain nullifier status.
//
// A note's nullifier = Poseidon([secret, leafIndex]), the same value the claim
// and join-split proofs bind. Once ANY path spends it (inbox claim OR a backup
// claim link), the contract records the nullifier and rejects every later
// claim with Error::NullifierUsed (#6). The inbox uses this to render
// already-spent notes as claimed instead of offering a Claim button that would
// fail on submit.
//
// The secret never leaves the browser: we compute the commitment and nullifier
// locally. Only the commitment goes to the resolver (to learn the note's tree
// index) and only the nullifier goes to the contract's read-only getter.

import * as StellarSdk from "@stellar/stellar-sdk";
import { computeCommitment, noteNullifier } from "./commitment";
import type { ClaimPayload } from "./claim_link";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;
const RESOLVER_URL = process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";

/** The note's nullifier as 32-byte big-endian hex, or null when the resolver
 *  does not have the note in its tree yet (so it cannot have been claimed).
 *  Same formula as backend/src/invite.ts's nullifierHexFromSecret. */
export async function nullifierHexForNote(p: ClaimPayload): Promise<string | null> {
  const secretDec = BigInt("0x" + p.secret).toString();
  const commitment = computeCommitment(
    secretDec,
    p.recipientDigest,
    String(p.amount),
    String(p.tokenId ?? 0)
  );
  const res = await fetch(`${RESOLVER_URL}/path?commitment=${encodeURIComponent(commitment)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`path lookup failed (${res.status})`);
  const { leafIndex } = (await res.json()) as { leafIndex?: number };
  if (typeof leafIndex !== "number") throw new Error("path lookup returned no leafIndex");
  return BigInt(noteNullifier(secretDec, leafIndex)).toString(16).padStart(64, "0");
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
