// Tests for the Jubjub gadgets in circuits/src/jubjub/, checked against the
// off-circuit reference in circuits/scripts/jubjub-ref.mjs.
//
// For each compiled test circuit (circuits/test/build/*_test.wasm), a witness
// is generated with the snarkjs CLI (same mechanism circuits/scripts/gen-test-proof.mjs
// uses), and output signal values are read out by index from the compiled
// .sym file rather than hardcoded.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { G, H, add, double, mul, isOnCurve, subgroupOrder } from '../scripts/jubjub-ref.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build');
const SNARKJS_CLI = path.join(HERE, '../node_modules/snarkjs/build/cli.cjs');

function symIndex(circuitName) {
  const lines = fs.readFileSync(path.join(BUILD, `${circuitName}.sym`), 'utf8').trim().split('\n');
  const map = {};
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 4) continue;
    map[parts[3].trim()] = parseInt(parts[0], 10);
  }
  return map;
}

// Runs the wasm witness calculator via snarkjs CLI. Returns the witness
// array of decimal strings, or throws if witness generation fails
// (e.g. an unsatisfied constraint, such as JubjubCheck rejecting an
// off-curve point).
function calculateWitness(circuitName, input) {
  const tag = Math.random().toString(36).slice(2);
  const inputPath = path.join(BUILD, `_${circuitName}_${tag}_input.json`);
  const wtnsPath = path.join(BUILD, `_${circuitName}_${tag}.wtns`);
  const jsonPath = path.join(BUILD, `_${circuitName}_${tag}_witness.json`);
  const wasmPath = path.join(BUILD, `${circuitName}_js`, `${circuitName}.wasm`);
  fs.writeFileSync(inputPath, JSON.stringify(input));
  try {
    execFileSync(process.execPath, [SNARKJS_CLI, 'wtns', 'calculate', wasmPath, inputPath, wtnsPath], { stdio: 'pipe' });
    execFileSync(process.execPath, [SNARKJS_CLI, 'wtns', 'export', 'json', wtnsPath, jsonPath], { stdio: 'pipe' });
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } finally {
    fs.rmSync(inputPath, { force: true });
    fs.rmSync(wtnsPath, { force: true });
    fs.rmSync(jsonPath, { force: true });
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
test('JubjubAdd: G + H', () => {
  const idx = symIndex('jubjub_add_test');
  const w = calculateWitness('jubjub_add_test', {
    x1: G.x.toString(), y1: G.y.toString(), x2: H.x.toString(), y2: H.y.toString(),
  });
  const expected = add(G, H);
  assert.strictEqual(w[idx['main.xout']], expected.x.toString());
  assert.strictEqual(w[idx['main.yout']], expected.y.toString());
});

test('JubjubAdd: random point pair', () => {
  const idx = symIndex('jubjub_add_test');
  const P = randomPoint();
  const Q = randomPoint();
  const w = calculateWitness('jubjub_add_test', {
    x1: P.x.toString(), y1: P.y.toString(), x2: Q.x.toString(), y2: Q.y.toString(),
  });
  const expected = add(P, Q);
  assert.strictEqual(w[idx['main.xout']], expected.x.toString());
  assert.strictEqual(w[idx['main.yout']], expected.y.toString());
});

// ── JubjubDbl ────────────────────────────────────────────────────────────────
test('JubjubDbl: double G', () => {
  const idx = symIndex('jubjub_dbl_test');
  const w = calculateWitness('jubjub_dbl_test', { x: G.x.toString(), y: G.y.toString() });
  const expected = double(G);
  assert.strictEqual(w[idx['main.xout']], expected.x.toString());
  assert.strictEqual(w[idx['main.yout']], expected.y.toString());
});

// ── JubjubCheck ──────────────────────────────────────────────────────────────
test('JubjubCheck: accepts G', () => {
  assert.doesNotThrow(() => calculateWitness('jubjub_check_test', { x: G.x.toString(), y: G.y.toString() }));
});

test('JubjubCheck: accepts H', () => {
  assert.doesNotThrow(() => calculateWitness('jubjub_check_test', { x: H.x.toString(), y: H.y.toString() }));
});

test('JubjubCheck: accepts a random valid point', () => {
  const P = randomPoint();
  assert.ok(isOnCurve(P));
  assert.doesNotThrow(() => calculateWitness('jubjub_check_test', { x: P.x.toString(), y: P.y.toString() }));
});

test('JubjubCheck: rejects an off-curve point', () => {
  assert.ok(!isOnCurve({ x: 1n, y: 1n }));
  assert.throws(() => calculateWitness('jubjub_check_test', { x: '1', y: '1' }));
});

// ── EscalarMulFix ────────────────────────────────────────────────────────────
function checkMulFix(k) {
  const idx = symIndex('jubjub_mulfix_test');
  const w = calculateWitness('jubjub_mulfix_test', { scalar: k.toString() });
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
