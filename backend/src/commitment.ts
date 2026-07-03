// Commitment = Poseidon([secret, recipientDigest, denom]) over BLS12-381.
// Computed in-process via the JS Poseidon that's been verified against the
// on-chain circuit (see poseidon.test.ts).

import { poseidon, BLS_R } from "./poseidon.js";

const DEC_RE = /^\d+$/;
const ALLOWED_DENOMS = new Set(["1", "10", "50", "100"]);

function isValidFr(s: string): boolean {
  if (!DEC_RE.test(s)) return false;
  return BigInt(s) < BLS_R;
}

export function computeCommitment(
  secret: string,
  recipientDigest: string,
  denom: string
): string {
  if (!isValidFr(secret) || !isValidFr(recipientDigest))
    throw new Error("secret and recipientDigest must be decimal < BLS12-381 r");
  if (!ALLOWED_DENOMS.has(denom))
    throw new Error("denom must be one of 1, 10, 50, 100");
  return poseidon([secret, recipientDigest, denom]);
}

export function computeNullifier(secret: string): string {
  if (!isValidFr(secret))
    throw new Error("secret must be decimal < BLS12-381 r");
  return poseidon([secret]);
}
