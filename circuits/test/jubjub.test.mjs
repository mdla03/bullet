// Tests for the Jubjub gadgets in circuits/src/jubjub/, checked against the
// off-circuit reference in circuits/scripts/jubjub-ref.mjs.
//
// For each compiled test circuit (circuits/test/build/*_test.wasm), a witness
// is generated in-process via snarkjs (as a library, not the CLI), and output
// signal values are read out by index from the compiled .sym file rather
// than hardcoded.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { symIndex } from '../scripts/sym.mjs';
import { G, H, add, double, mul, isOnCurve, subgroupOrder, commit, randomBlinding, blindingMax } from '../scripts/jubjub-ref.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build');

// Reproducible "random" inputs. A failure that reproduces only on the run that
// found it is not a failure anyone can fix, so every random value below comes
// from a seeded xorshift32 rather than Math.random(). The seed is printed on
// every run: to replay a failing one, re-run with JUBJUB_SEED set to it.
const SEED = (Number(process.env.JUBJUB_SEED ?? 0x5eed1234) >>> 0) || 1;
console.log(`jubjub.test.mjs random seed: ${SEED} (set JUBJUB_SEED to change)`);
let rngState = SEED;
function rand32() {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return rngState;
}

// The source line each range check sits on, read out of the circuit instead of
// hardcoded. The witness error names the line, so the rejection tests below can
// pin the exact constraint that failed rather than accepting any failure
// anywhere in PedersenCommit: the amount bound and the blinding bound are two
// different Num2Bits instances and would otherwise be indistinguishable.
const PEDERSEN_SRC = fs
  .readFileSync(path.join(HERE, '..', 'src', 'jubjub', 'pedersen_commit.circom'), 'utf8')
  .split(/\r?\n/);
function circuitLineOf(needle) {
  const i = PEDERSEN_SRC.findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `pedersen_commit.circom no longer contains "${needle}"`);
  return i + 1;
}
const AMOUNT_RANGE_LINE = circuitLineOf('amountBits.in <== amount;');
const BLINDING_RANGE_LINE = circuitLineOf('blindingBits.in <== blinding;');
assert.notEqual(AMOUNT_RANGE_LINE, BLINDING_RANGE_LINE);

/** Asserts the witness failed in `template` at `line` of pedersen_commit.circom
 *  and nowhere else. snarkjs puts both in the thrown message, e.g.
 *  "Assert Failed. Error in template Num2Bits_0 line: 38
 *   Error in template PedersenCommit_14 line: 55". */
function failsAt(template, line) {
  return (e) => {
    assert.match(e.message, new RegExp(`template ${template}_\\d+ line:`),
      `expected the failure inside ${template}, got: ${e.message}`);
    assert.match(e.message, new RegExp(`template PedersenCommit_\\d+ line: ${line}\\b`),
      `expected the failure at pedersen_commit.circom line ${line}, got: ${e.message}`);
    return true;
  };
}

function symIndexFor(circuitName) {
  return symIndex(path.join(BUILD, `${circuitName}.sym`));
}

// Calculates the wasm witness in-process (snarkjs as a library, no CLI
// spawn). Returns the witness as an array of decimal strings, or throws if
// witness generation fails (e.g. an unsatisfied constraint, such as
// JubjubCheck rejecting an off-curve point).
let wtnsCounter = 0;
async function calculateWitness(circuitName, input) {
  const tag = `${process.pid}_${wtnsCounter++}`;
  const wtnsPath = path.join(BUILD, `_${circuitName}_${tag}.wtns`);
  const wasmPath = path.join(BUILD, `${circuitName}_js`, `${circuitName}.wasm`);
  try {
    await snarkjs.wtns.calculate(input, wasmPath, wtnsPath);
    const witness = await snarkjs.wtns.exportJson(wtnsPath);
    return witness.map(String);
  } finally {
    fs.rmSync(wtnsPath, { force: true });
  }
}

function randomPoint() {
  // A random valid curve point: k*G for a random small-ish scalar.
  const k = BigInt(1 + (rand32() % 1_000_000));
  return mul(k, G);
}

function randomScalar64() {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(rand32() & 0xff);
  return v & ((1n << 64n) - 1n);
}

/** Seeded stand-in for jubjub-ref's randomBlinding(), same [0, 2^251) range.
 *  The reference's own crypto-random version is exercised by the sanity test at
 *  the bottom; the commitment tests need a value they can reproduce. */
function seededBlinding() {
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(rand32() & 0xff);
  return v & (blindingMax - 1n);
}

// ── JubjubAdd ────────────────────────────────────────────────────────────────
test('JubjubAdd: G + H', async () => {
  const idx = symIndexFor('jubjub_add_test');
  const w = await calculateWitness('jubjub_add_test', {
    x1: G.x.toString(), y1: G.y.toString(), x2: H.x.toString(), y2: H.y.toString(),
  });
  const expected = add(G, H);
  assert.strictEqual(w[idx['main.xout']], expected.x.toString());
  assert.strictEqual(w[idx['main.yout']], expected.y.toString());
});

test('JubjubAdd: random point pair', async () => {
  const idx = symIndexFor('jubjub_add_test');
  const P = randomPoint();
  const Q = randomPoint();
  const w = await calculateWitness('jubjub_add_test', {
    x1: P.x.toString(), y1: P.y.toString(), x2: Q.x.toString(), y2: Q.y.toString(),
  });
  const expected = add(P, Q);
  assert.strictEqual(w[idx['main.xout']], expected.x.toString());
  assert.strictEqual(w[idx['main.yout']], expected.y.toString());
});

// ── JubjubDbl ────────────────────────────────────────────────────────────────
test('JubjubDbl: double G', async () => {
  const idx = symIndexFor('jubjub_dbl_test');
  const w = await calculateWitness('jubjub_dbl_test', { x: G.x.toString(), y: G.y.toString() });
  const expected = double(G);
  assert.strictEqual(w[idx['main.xout']], expected.x.toString());
  assert.strictEqual(w[idx['main.yout']], expected.y.toString());
});

// ── JubjubCheck ──────────────────────────────────────────────────────────────
test('JubjubCheck: accepts G', async () => {
  await assert.doesNotReject(calculateWitness('jubjub_check_test', { x: G.x.toString(), y: G.y.toString() }));
});

test('JubjubCheck: accepts H', async () => {
  await assert.doesNotReject(calculateWitness('jubjub_check_test', { x: H.x.toString(), y: H.y.toString() }));
});

test('JubjubCheck: accepts a random valid point', async () => {
  const P = randomPoint();
  assert.ok(isOnCurve(P));
  await assert.doesNotReject(calculateWitness('jubjub_check_test', { x: P.x.toString(), y: P.y.toString() }));
});

test('JubjubCheck: rejects an off-curve point', async () => {
  assert.ok(!isOnCurve({ x: 1n, y: 1n }));
  // Matched on the component name: (1,1) is off-curve, so the ONLY constraint
  // that may reject it is JubjubCheck's curve equation. Any other unsatisfied
  // constraint would be this test passing for the wrong reason.
  await assert.rejects(
    calculateWitness('jubjub_check_test', { x: '1', y: '1' }),
    /template JubjubCheck_\d+ line:/
  );
});

// ── EscalarMulFix ────────────────────────────────────────────────────────────
async function checkMulFix(k) {
  const idx = symIndexFor('jubjub_mulfix_test');
  const w = await calculateWitness('jubjub_mulfix_test', { scalar: k.toString() });
  const expected = mul(k, G);
  // mul(0, G) is the identity (0,1); EscalarMulFix does not special-case it,
  // but the circuit is still expected to produce the same affine identity.
  assert.strictEqual(w[idx['main.out[0]']], expected.x.toString());
  assert.strictEqual(w[idx['main.out[1]']], expected.y.toString());
}

test('EscalarMulFix: k=0', () => checkMulFix(0n));
test('EscalarMulFix: k=1', () => checkMulFix(1n));
test('EscalarMulFix: k=2', () => checkMulFix(2n));
test('EscalarMulFix: k=2^64-1', () => checkMulFix((1n << 64n) - 1n));
test('EscalarMulFix: random 64-bit scalar 1', () => checkMulFix(randomScalar64()));
test('EscalarMulFix: random 64-bit scalar 2', () => checkMulFix(randomScalar64()));
test('EscalarMulFix: random 64-bit scalar 3', () => checkMulFix(randomScalar64()));

test('EscalarMulFix: fixed-base multiply by random scalars never hits the identity', async () => {
  // Guards the unconstrained-division degeneracy in MontgomeryAdd/
  // MontgomeryDouble (see circuits/src/jubjub/montgomery.circom): if a
  // segment adder inside EscalarMulFix ever added a point to itself, to the
  // identity, or hit a zero divisor, the circuit output would collapse to
  // the identity here. Checked against the circuit's own witness output
  // before the equality check below, so this can fail on its own instead of
  // only ever failing alongside it.
  const idx = symIndexFor('jubjub_mulfix_test');
  for (let i = 0; i < 8; i++) {
    const k = randomScalar64();
    const w = await calculateWitness('jubjub_mulfix_test', { scalar: k.toString() });
    const where = `k=${k} (seed ${SEED})`;
    assert.notDeepStrictEqual(
      [w[idx['main.out[0]']], w[idx['main.out[1]']]],
      ['0', '1'],
      `EscalarMulFix output was the identity for ${where}`
    );
    const expected = mul(k, G);
    assert.notStrictEqual(expected.x, 0n, `reference itself hit the identity for ${where}`);
    assert.strictEqual(w[idx['main.out[0]']], expected.x.toString(), `x mismatch for ${where}`);
    assert.strictEqual(w[idx['main.out[1]']], expected.y.toString(), `y mismatch for ${where}`);
  }
});

// ── PedersenCommit ───────────────────────────────────────────────────────────
async function checkCommit(amount, blinding) {
  const idx = symIndexFor('pedersen_commit_test');
  const w = await calculateWitness('pedersen_commit_test', {
    amount: amount.toString(), blinding: blinding.toString(),
  });
  const expected = commit(amount, blinding);
  const where = `amount=${amount} blinding=${blinding} (seed ${SEED})`;
  assert.strictEqual(w[idx['main.cx']], expected.x.toString(), `cx mismatch for ${where}`);
  assert.strictEqual(w[idx['main.cy']], expected.y.toString(), `cy mismatch for ${where}`);
  return expected;
}

test('PedersenCommit: pinned sample (amount 37, blinding 12345)', async () => {
  const c = await checkCommit(37n, 12345n);
  // Pinned against the jubjub-ref.mjs printed sample, so a drift in either G,
  // H, or the circuit's copies of them fails here rather than silently.
  assert.strictEqual(c.x.toString(), '45698945774435739926801948253091155734572283544145897043617877029042215456708');
  assert.strictEqual(c.y.toString(), '9314562124973391845024092063267342551607489952627410574825363956335655348463');
});

test('PedersenCommit: (0, 0) is the identity point', async () => {
  const c = await checkCommit(0n, 0n);
  assert.strictEqual(c.x, 0n);
  assert.strictEqual(c.y, 1n);
});

test('PedersenCommit: amount 2^64-1 with a random blinding', () =>
  checkCommit((1n << 64n) - 1n, seededBlinding()));

test('PedersenCommit: random 64-bit amount with a random blinding', () =>
  checkCommit(randomScalar64(), seededBlinding()));

test('PedersenCommit: rejects amount = 2^64', () =>
  assert.rejects(
    calculateWitness('pedersen_commit_test', {
      amount: (1n << 64n).toString(), blinding: '0',
    }),
    // Pinned to the amount decomposition. The blinding has its own Num2Bits a
    // few lines down, and a rejection there would mean the amount bound is not
    // the thing being proven.
    failsAt('Num2Bits', AMOUNT_RANGE_LINE)
  ));

test('PedersenCommit: rejects blinding = 2^251', () =>
  assert.rejects(
    calculateWitness('pedersen_commit_test', {
      amount: '1', blinding: blindingMax.toString(),
    }),
    failsAt('Num2Bits', BLINDING_RANGE_LINE)
  ));

test('PedersenCommit: accepts blinding = 2^251 - 1, the largest in range', () =>
  checkCommit(1n, blindingMax - 1n));

// sanity on the reference itself, so a broken subgroupOrder import fails loud
test('reference sanity: subgroupOrder is nonzero', () => {
  assert.ok(subgroupOrder > 0n);
});

test('reference sanity: blindings stay below the subgroup order', () => {
  assert.ok(blindingMax < subgroupOrder);
  assert.ok(randomBlinding() < blindingMax);
});
