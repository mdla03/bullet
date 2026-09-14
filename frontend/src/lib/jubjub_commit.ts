// Jubjub Pedersen commitment, computed with @noble/curves (the audited
// library circuits/scripts/jubjub-ref.mjs uses) instead of hand-rolled
// field/curve arithmetic, since amountCommitmentX/Y are constrained inputs
// on the claim circuit's funds path.
//
// G is noble's jubjub base point. H is pinned from jubjub-ref.mjs's own
// `findGroupHash(Buffer.from('r'), Buffer.from('Zcash_cv'))` output (Zcash's
// group hash), pasted rather than recomputed here because findGroupHash
// needs node's Buffer, which Next.js does not polyfill into client bundles.
// Both points are asserted on-curve at module load via noble's own point
// validation, so a wrong constant fails immediately instead of producing
// silently-invalid commitments.
//
// commit(amount, blinding) = amount*G + blinding*H, matching
// PedersenCommit in circuits/src/jubjub/pedersen_commit.circom.

import { jubjub } from "@noble/curves/jubjub";

const G = { x: jubjub.CURVE.Gx, y: jubjub.CURVE.Gy };
const H = {
  x: 47042227020334719030310671629496501061777616454137182971856918820250544653111n,
  y: 49531484613049745751551498609154147537293487462303198979615882148044956461707n,
};

const Gp = jubjub.Point.fromAffine(G);
const Hp = jubjub.Point.fromAffine(H);
Gp.assertValidity();
Hp.assertValidity();

/** Number of bits the blinding factor is sampled from (see prove_browser.ts). */
export const BLINDING_BITS = 251n;

// noble's Point.multiply rejects a scalar of 0 (it requires 1 <= scalar <
// curve order), so that case is handled explicitly with the identity rather
// than falling back to the non-constant-time multiplyUnsafe.
function mul(k: bigint, base: typeof Gp): typeof Gp {
  if (k === 0n) return jubjub.Point.ZERO;
  return base.multiply(k);
}

/** Pedersen commitment amount*G + blinding*H, as decimal-string coordinates. */
export function commit(
  amount: bigint | string,
  blinding: bigint | string
): { x: string; y: string } {
  const c = mul(BigInt(amount), Gp).add(mul(BigInt(blinding), Hp));
  const affine = c.toAffine();
  return { x: affine.x.toString(), y: affine.y.toString() };
}
