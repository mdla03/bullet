// Client-side commitment = Poseidon([secret, recipientDigest, amount, tokenId])
// over BLS12-381. Computed in the browser so the claim `secret` never leaves the
// tab. Matches the on-chain claim circuit and backend Poseidon exactly.
// `amount` is the raw stroop value (7 decimal places; e.g. "100000000" for 10 USDC).
// `tokenId` binds the token (0 = USDC, 1 = XLM) to prevent cross-token claims.

import { poseidon, BLS_R } from "./poseidon";

const DEC_RE = /^\d+$/;

function isValidFr(dec: string): boolean {
  return DEC_RE.test(dec) && BigInt(dec) < BLS_R;
}

export function computeCommitment(
  secretDec: string,
  recipientDigestDec: string,
  amount: string,
  tokenId: string = "0"
): string {
  if (!isValidFr(secretDec) || !isValidFr(recipientDigestDec))
    throw new Error("secret and recipientDigest must be decimal < BLS12-381 r");
  if (!DEC_RE.test(amount) || BigInt(amount) <= 0n)
    throw new Error("amount must be a positive decimal integer (stroops)");
  if (!DEC_RE.test(tokenId))
    throw new Error("tokenId must be a non-negative decimal integer");
  return poseidon([secretDec, recipientDigestDec, amount, tokenId]);
}
