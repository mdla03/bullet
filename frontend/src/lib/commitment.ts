// Client-side commitment = Poseidon([secret, recipientDigest, denom]) over
// BLS12-381. Computed in the browser so the claim `secret` never leaves the
// tab (previously it was POSTed to the backend /commitment endpoint). Matches
// the on-chain claim circuit and backend Poseidon exactly.

import { poseidon, BLS_R } from "./poseidon";

const DEC_RE = /^\d+$/;
const ALLOWED_DENOMS = new Set(["1", "10", "50", "100"]);

function isValidFr(dec: string): boolean {
  return DEC_RE.test(dec) && BigInt(dec) < BLS_R;
}

export function computeCommitment(
  secretDec: string,
  recipientDigestDec: string,
  denom: string
): string {
  if (!isValidFr(secretDec) || !isValidFr(recipientDigestDec))
    throw new Error("secret and recipientDigest must be decimal < BLS12-381 r");
  if (!ALLOWED_DENOMS.has(denom))
    throw new Error("denom must be one of 1, 10, 50, 100");
  return poseidon([secretDec, recipientDigestDec, denom]);
}
