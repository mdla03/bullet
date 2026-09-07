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
import { G, H, add, double, mul, isOnCurve, subgroupOrder } from '../scripts/jubjub-ref.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build');

function symIndexFor(circuitName) {
  return symIndex(path.join(BUILD, `${circuitName}.sym`));
}

// Calculates the wasm witness in-process (snarkjs as a library, no CLI
// spawn). Returns the witness as an array of decimal strings, or throws if
// witness generation fails (e.g. an unsatisfied constraint, such as
// JubjubCheck rejecting an off-curve point).
async function calculateWitness(circuitName, input) {
  const tag = Math.random().toString(36).slice(2);
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
  const k = BigInt(1 + Math.floor(Math.random() * 1_000_000));
  return mul(k, G);
}

function randomScalar64() {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(Math.floor(Math.random() * 256));
  return v & ((1n << 64n) - 1n);
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
  await assert.rejects(calculateWitness('jubjub_check_test', { x: '1', y: '1' }));
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

// sanity on the reference itself, so a broken subgroupOrder import fails loud
test('reference sanity: subgroupOrder is nonzero', () => {
  assert.ok(subgroupOrder > 0n);
});
