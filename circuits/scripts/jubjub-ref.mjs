// Off-circuit reference: Pedersen amount commitment on Jubjub (twisted Edwards
// embedded in the BLS12-381 scalar field, matching circom -p bls12381).
//
// Sources:
// - Zcash Protocol Spec, "Jubjub" section: defines a, d, base point, subgroup
//   order (2^252-ish h=8 cofactor curve) and Montgomery form A=40962, B=1.
// - noble-curves v1.9.7: @noble/curves/jubjub (jubjub.js), which re-exports
//   the real curve object + group-hash helpers from misc.js. It ships a ready
//   made `jubjub` twistedEdwards() curve and `findGroupHash`, so we used that
//   directly instead of building the curve by hand with twistedEdwards().
// - Montgomery A/B: hardcoded as the known spec constants (40962, 1). The
//   derivation formula A = 2(a+d)/(a-d), B = 4/(a-d) mod r is cross-checked
//   for A only below (A is invariant under Jubjub's twist scaling; B is not
//   see comment at the self-check for why).
// - H (second generator): noble exposes findGroupHash, so we derive H via
//   Zcash's own group hash, domain "Zcash_cv", message "r" (this is Sapling's
//   *value-commitment randomness* base, repurposed here as an independent
//   Pedersen generator with no known discrete-log relation to G). The
//   SHA-256 + cofactor-clearing fallback described in the task was not
//   needed since noble ships the real group hash.

import { jubjub, findGroupHash } from '@noble/curves/jubjub';
import { invert } from '@noble/curves/abstract/modular';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert';
import { pathToFileURL } from 'node:url';

export const Fr = jubjub.CURVE.p;
export const a = jubjub.CURVE.a;
export const d = jubjub.CURVE.d;
export const subgroupOrder = jubjub.CURVE.n;
export const cofactor = jubjub.CURVE.h; // 8n
export const montgomeryA = 40962n; // known Zcash spec constant (cross-checked below)
export const montgomeryB = 1n;

export const G = { x: jubjub.CURVE.Gx, y: jubjub.CURVE.Gy };

const Hpoint = findGroupHash(Buffer.from('r'), Buffer.from('Zcash_cv'));
export const H = { x: Hpoint.x, y: Hpoint.y };

const toExt = (P) => jubjub.Point.fromAffine({ x: P.x, y: P.y });
const fromExt = (P) => { const c = P.toAffine(); return { x: c.x, y: c.y }; };

// Thin wrappers around noble's own ExtendedPoint add/double (no reimplemented
// field arithmetic). We avoid noble's Point.multiply()/multiplyUnsafe() here
// because they reject scalar=0 or scalar>=subgroupOrder, both of which the
// self-check below needs to exercise directly.
export function add(P, Q) { return fromExt(toExt(P).add(toExt(Q))); }
export function double(P) { return fromExt(toExt(P).double()); }

export function mul(k, P) {
  if (k < 0n) throw new Error('mul: negative scalar not supported');
  let acc = jubjub.Point.ZERO;
  let base = toExt(P);
  while (k > 0n) {
    if (k & 1n) acc = acc.add(base);
    base = base.double();
    k >>= 1n;
  }
  return fromExt(acc);
}

const modr = (x) => { x %= Fr; return x < 0n ? x + Fr : x; };

export function isOnCurve(P) {
  const x2 = modr(P.x * P.x), y2 = modr(P.y * P.y);
  return modr(a * x2 + y2) === modr(1n + d * x2 * y2);
}

export function commit(amount, blinding) {
  return add(mul(BigInt(amount), G), mul(BigInt(blinding), H));
}

export function randomBlinding() {
  const bytes = Math.ceil(subgroupOrder.toString(2).length / 8);
  while (true) {
    let v = 0n;
    for (const b of randomBytes(bytes)) v = (v << 8n) | BigInt(b);
    if (v < subgroupOrder) return v;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hex = (x) => '0x' + x.toString(16);
  const sample = commit(37, 12345);
  console.log(JSON.stringify({
    Fr: Fr.toString(), Fr_hex: hex(Fr),
    a: a.toString(), a_hex: hex(a),
    d: d.toString(), d_hex: hex(d),
    montgomeryA: montgomeryA.toString(), montgomeryA_hex: hex(montgomeryA),
    montgomeryB: montgomeryB.toString(), montgomeryB_hex: hex(montgomeryB),
    subgroupOrder: subgroupOrder.toString(), subgroupOrder_hex: hex(subgroupOrder),
    cofactor: cofactor.toString(), cofactor_hex: hex(cofactor),
    G: { x: G.x.toString(), y: G.y.toString() },
    G_hex: { x: hex(G.x), y: hex(G.y) },
    H: { x: H.x.toString(), y: H.y.toString() },
    H_hex: { x: hex(H.x), y: hex(H.y) },
    sampleCommitment_amount37_blinding12345: { x: sample.x.toString(), y: sample.y.toString() },
  }, null, 2));

  assert(isOnCurve(G) && !(G.x === 0n && G.y === 1n), 'G invalid or identity');
  assert(isOnCurve(H) && !(H.x === 0n && H.y === 1n), 'H invalid or identity');

  const idG = mul(subgroupOrder, G);
  assert(idG.x === 0n && idG.y === 1n, 'subgroupOrder * G != identity');
  const idH = mul(subgroupOrder, H);
  assert(idH.x === 0n && idH.y === 1n, 'subgroupOrder * H != identity');

  const a1 = BigInt(Math.floor(Math.random() * 1000));
  const a2 = BigInt(Math.floor(Math.random() * 1000));
  const r1 = randomBlinding(), r2 = randomBlinding();
  const lhs = add(commit(a1, r1), commit(a2, r2));
  const rhs = commit(a1 + a2, r1 + r2);
  assert(lhs.x === rhs.x && lhs.y === rhs.y, 'commitment homomorphism failed');

  const zero = commit(0, 0);
  assert(zero.x === 0n && zero.y === 1n, 'commit(0,0) != identity');

  // Modular inverse (Fr is prime) to cross-check A = 2(a+d)/(a-d).
  // Note: B = 4/(a-d) is NOT cross-checked here. Jubjub's published (a,d) is a
  // non-square-scaled (quadratic twist) copy of the "canonical" a=1-style
  // Edwards curve reached by the textbook birational map; that scaling
  // (x,y) -> (c*x, y) leaves A invariant (confirmed below) but rescales B by
  // 1/c^2, so B can't be recovered from (a,d) without also knowing c. We take
  // montgomeryB=1 directly from the spec instead, as the task allows.
  const invAminusD = invert(modr(a - d), Fr);
  const computedA = modr(2n * modr(a + d) * invAminusD);
  if (computedA !== montgomeryA) {
    console.log('montgomery A mismatch: computed', computedA.toString(), 'expected', montgomeryA.toString());
    assert(false, 'montgomery A derived from a,d does not match the known constant');
  }

  console.log('self-check ok');
}
