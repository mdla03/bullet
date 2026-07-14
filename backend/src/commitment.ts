// Commitment = Poseidon([secret, recipientDigest, amount, tokenId]) over BLS12-381.
// Computed in-process via the JS Poseidon that's been verified against the
// on-chain circuit (see poseidon.test.ts).
// `amount` is the raw stroop value (7 decimal places; e.g. "100000000" for 10 USDC).
// `tokenId` binds the token (0 = USDC, 1 = XLM) to prevent cross-token claims.

import { poseidon, BLS_R } from "./poseidon.js";

const DEC_RE = /^\d+$/;

function isValidFr(s: string): boolean {
  if (!DEC_RE.test(s)) return false;
  return BigInt(s) < BLS_R;
}

export function computeCommitment(
  secret: string,
  recipientDigest: string,
  amount: string,
  tokenId: string = "0"
): string {
  if (!isValidFr(secret) || !isValidFr(recipientDigest))
    throw new Error("secret and recipientDigest must be decimal < BLS12-381 r");
  if (!DEC_RE.test(amount) || BigInt(amount) <= 0n)
    throw new Error("amount must be a positive decimal integer (stroops)");
  if (!DEC_RE.test(tokenId))
    throw new Error("tokenId must be a non-negative decimal integer");
  return poseidon([secret, recipientDigest, amount, tokenId]);
}

export function computeNullifier(secret: string): string {
  if (!isValidFr(secret))
    throw new Error("secret must be decimal < BLS12-381 r");
  return poseidon([secret]);
}
