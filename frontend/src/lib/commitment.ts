// Client-side commitment = Poseidon([secret, recipientDigest, amount]) over
// BLS12-381. Computed in the browser so the claim `secret` never leaves the
// tab. Matches the on-chain claim circuit and backend Poseidon exactly.
// `amount` is the raw stroop value (7 decimal places; e.g. "100000000" for 10 USDC).

import { poseidon, BLS_R } from "./poseidon";

const DEC_RE = /^\d+$/;

function isValidFr(dec: string): boolean {
  return DEC_RE.test(dec) && BigInt(dec) < BLS_R;
}

export function computeCommitment(
  secretDec: string,
  recipientDigestDec: string,
  amount: string
): string {
  if (!isValidFr(secretDec) || !isValidFr(recipientDigestDec))
    throw new Error("secret and recipientDigest must be decimal < BLS12-381 r");
  if (!DEC_RE.test(amount) || BigInt(amount) <= 0n)
    throw new Error("amount must be a positive decimal integer (stroops)");
  return poseidon([secretDec, recipientDigestDec, amount]);
}
