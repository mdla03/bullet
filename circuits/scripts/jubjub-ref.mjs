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
// - Montgomery A/B: derived from (a, d) with A = 2(a+d)/(a-d), B = 4/(a-d)
//   mod r, the exact pair for the birational map circomlib's
//   montgomery.circom implements. A is cross-checked below against the spec's
//   40962. B is NOT 1: see the montgomeryB comment for why the spec's B and
//   this B are different numbers for different maps.
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
const modr = (x) => { x %= Fr; return x < 0n ? x + Fr : x; };

// Derived, never pasted. circomlib's montgomery.circom computes A and B from
// (a, d) at compile time with exactly these formulas, so these are the values
// the circuit actually runs on.
export const montgomeryA = modr(2n * modr(a + d) * invert(modr(a - d), Fr)); // 40962
// DO NOT replace this with the Zcash spec's B = 1. The spec states B for a
// differently-scaled Montgomery model of Jubjub; the map circomlib implements
// (u = (1+y)/(1-y), v = u/x) pins B = 4/(a-d) = -40964 mod r. Hardcoding 1
// makes EscalarMulFix silently compute the wrong point: proved by mutation,
// it fails all 7 EscalarMulFix cases in circuits/test/jubjub.test.mjs.
export const montgomeryB = modr(4n * invert(modr(a - d), Fr)); // -40964 mod r

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

export function isOnCurve(P) {
  const x2 = modr(P.x * P.x), y2 = modr(P.y * P.y);
  return modr(a * x2 + y2) === modr(1n + d * x2 * y2);
}

export function commit(amount, blinding) {
  return add(mul(BigInt(amount), G), mul(BigInt(blinding), H));
}

// Blindings are sampled below 2^251, not below subgroupOrder. The in-circuit
// PedersenCommit (circuits/src/jubjub/pedersen_commit.circom) decomposes the
// blinding with Num2Bits(251), so a value at or above 2^251 has no witness
// there. 2^251 < subgroupOrder (a 252-bit value), so this range is still
// injective on the group and the two sides agree exactly.
export const BLINDING_BITS = 251n;
export const blindingMax = 1n << BLINDING_BITS; // exclusive

export function randomBlinding() {
  let v = 0n;
  for (const b of randomBytes(32)) v = (v << 8n) | BigInt(b);
  return v & (blindingMax - 1n); // uniform on [0, 2^251)
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

  assert(blindingMax < subgroupOrder, '2^251 is not below the Jubjub subgroup order');

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

  // A is the one Montgomery constant the Zcash spec and circomlib's map agree
  // on, so it cross-checks the derivation against a published number.
  assert.strictEqual(montgomeryA, 40962n, 'derived Montgomery A != the Zcash spec constant 40962');
  // B does not agree, and that is the point: guard the exact value so nobody
  // "corrects" it back to the spec's B = 1 (see the comment on montgomeryB).
  assert.strictEqual(montgomeryB, modr(-40964n), 'derived Montgomery B != -40964; do not substitute the spec B = 1');

  console.log('self-check ok');
}
