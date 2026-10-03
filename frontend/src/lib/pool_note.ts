// Shielded-pool note model and the pure join-split arithmetic.
//
// A pool note is a spendable balance, not a one-shot claim link: it has a
// secret, a recipient digest, a value and a token, and once the indexer places
// it, a leaf index. Its commitment is Poseidon([secret, recipientDigest, value,
// tokenId]) — the same shape a `deposit` note has, which is why a deposit note
// can be spent into the pool. Its nullifier is Poseidon([secret]), identical to
// the claim path, so a note has ONE nullifier whichever entry point spends it
// (see contracts/zeekpay/src/lib.rs and the fix in joinsplit.circom). The split
// of this file from pool_tx.ts keeps the money arithmetic testable without a
// network or a signer.

import { poseidon } from "./poseidon";

/** JoinSplit(20, 64, 2, 2): the deployed pool's fixed shape. */
export const POOL_N_IN = 2;
export const POOL_N_OUT = 2;
export const POOL_DEPTH = 20;

/** A shielded-pool note. `leafIndex` is undefined until the indexer places it. */
export interface PoolNote {
  /** Decimal field element. The spend credential; never leaves the owner. */
  secret: string;
  /** Decimal field element identifying the owner (stealth-derived per payment). */
  recipientDigest: string;
  /** Raw stroops. */
  value: bigint;
  tokenId: number;
  leafIndex?: number;
}

/** Poseidon([secret, recipientDigest, value, tokenId]) as a decimal string. */
export function noteCommitment(n: PoolNote): string {
  return poseidon([n.secret, n.recipientDigest, n.value.toString(), String(n.tokenId)]);
}

/** Poseidon([secret]) as a decimal string. Matches claim.circom exactly, so a
 *  note spent through claim and a note spent through transact collide on this
 *  value and cannot both pay out. */
export function noteNullifier(n: PoolNote): string {
  return poseidon([n.secret]);
}

/** The balance equation the circuit enforces:
 *  sum(inputs) + publicDeposit === sum(outputs) + publicWithdraw.
 *  Checked here first so an unbalanced plan fails with a readable error instead
 *  of a silent witness-generation abort. */
export function isBalanced(
  inputs: readonly PoolNote[],
  outputs: readonly PoolNote[],
  publicDeposit: bigint,
  publicWithdraw: bigint
): boolean {
  const sumIn = inputs.reduce((a, n) => a + n.value, 0n);
  const sumOut = outputs.reduce((a, n) => a + n.value, 0n);
  return sumIn + publicDeposit === sumOut + publicWithdraw;
}

/** The leaf index encoded by a Merkle path's sibling-position bits, LSB first.
 *  The pool nullifier no longer depends on this, but the witness still needs
 *  leafIndex to equal the position the path proves. */
export function leafIndexFromPathIndices(pathIndices: readonly number[]): number {
  return pathIndices.reduce((acc, bit, k) => acc + (bit ? 2 ** k : 0), 0);
}
