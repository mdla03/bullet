// Commitment = Poseidon([secret, recipientDigest, amount]) over BLS12-381.
// Computed in-process via the JS Poseidon that's been verified against the
// on-chain circuit (see poseidon.test.ts).
// `amount` is the raw stroop value (7 decimal places; e.g. "100000000" for 10 USDC).

import { poseidon, BLS_R } from "./poseidon.js";

const DEC_RE = /^\d+$/;

function isValidFr(s: string): boolean {
  if (!DEC_RE.test(s)) return false;
  return BigInt(s) < BLS_R;
}

export function computeCommitment(
  secret: string,
  recipientDigest: string,
  amount: string
): string {
  if (!isValidFr(secret) || !isValidFr(recipientDigest))
    throw new Error("secret and recipientDigest must be decimal < BLS12-381 r");
  if (!DEC_RE.test(amount) || BigInt(amount) <= 0n)
    throw new Error("amount must be a positive decimal integer (stroops)");
  return poseidon([secret, recipientDigest, amount]);
}

export function computeNullifier(secret: string): string {
  if (!isValidFr(secret))
    throw new Error("secret must be decimal < BLS12-381 r");
  return poseidon([secret]);
}
