// Sanity check for the served (frontend/public/circuits) claim.wasm/claim.zkey:
// prove circuits/build/claim_input.json with a fresh blinding, verify against
// circuits/build/claim_vk.json, and assert the 7-public-input shape the
// production claim flow (prove_browser.ts) expects.
//
// Run: node frontend/scripts/check-claim-input.mjs

import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as snarkjs from "snarkjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const WASM_PATH = path.join(root, "frontend", "public", "circuits", "claim.wasm");
const ZKEY_PATH = path.join(root, "frontend", "public", "circuits", "claim.zkey");
const INPUT_PATH = path.join(root, "circuits", "build", "claim_input.json");
const VK_PATH = path.join(root, "circuits", "build", "claim_vk.json");

// Matches circuits/scripts/jubjub-ref.mjs randomBlinding: uniform on [0, 2^251).
function randomBlinding() {
  const bytes = randomBytes(32);
  bytes[0] &= 0b00000111; // clear the top 5 bits (256 - 251)
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v.toString();
}

// Same Pedersen commitment as frontend/src/lib/jubjub_commit.ts (duplicated
// here so this check script has no dependency beyond snarkjs).
const Fr = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const CA = 52435875175126190479447740508185965837690552500527637822603658699938581184512n;
const CD = 19257038036680949359750312669786877991949435402254120286184196891950884077233n;
const G = { x: 8076246640662884909881801758704306714034609987455869804520522091855516602923n, y: 13262374693698910701929044844600465831413122818447359594527400194675274060458n };
const H = { x: 47042227020334719030310671629496501061777616454137182971856918820250544653111n, y: 49531484613049745751551498609154147537293487462303198979615882148044956461707n };
const mod = (x, m = Fr) => { x %= m; return x < 0n ? x + m : x; };
function invert(x, m = Fr) {
  let [oldR, r] = [mod(x, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, m);
}
function add(P, Q) {
  const x1x2 = mod(P.x * Q.x), y1y2 = mod(P.y * Q.y);
  const x1y2 = mod(P.x * Q.y), y1x2 = mod(P.y * Q.x);
  const dm = mod(CD * mod(x1x2 * y1y2));
  return {
    x: mod((x1y2 + y1x2) * invert(mod(1n + dm))),
    y: mod((y1y2 - mod(CA * x1x2)) * invert(mod(1n - dm))),
  };
}
function mul(k, P) {
  let acc = { x: 0n, y: 1n };
  let base = P;
  while (k > 0n) {
    if (k & 1n) acc = add(acc, base);
    base = add(base, base);
    k >>= 1n;
  }
  return acc;
}
function pedersenCommit(amount, blinding) {
  const c = add(mul(BigInt(amount), G), mul(BigInt(blinding), H));
  return { x: c.x.toString(), y: c.y.toString() };
}

// Self-check against the pinned sample from circuits/scripts/jubjub-ref.mjs
// (also asserted in frontend/src/lib/jubjub_commit.ts's noble-based commit):
// commit(37, 12345) must equal this fixed point, or the curve arithmetic
// above (and the noble-based commit it mirrors) has drifted.
{
  const sample = pedersenCommit(37n, 12345n);
  const expected = {
    x: "45698945774435739926801948253091155734572283544145897043617877029042215456708",
    y: "9314562124973391845024092063267342551607489952627410574825363956335655348463",
  };
  if (sample.x !== expected.x || sample.y !== expected.y) {
    throw new Error(
      `pedersenCommit self-check failed: got (${sample.x}, ${sample.y}), expected (${expected.x}, ${expected.y})`
    );
  }
}

async function main() {
  const [wasm, zkey, input, vk] = await Promise.all([
    readFile(WASM_PATH),
    readFile(ZKEY_PATH),
    readFile(INPUT_PATH, "utf8").then(JSON.parse),
    readFile(VK_PATH, "utf8").then(JSON.parse),
  ]);

  input.blinding = randomBlinding();
  const { x, y } = pedersenCommit(input.amount, input.blinding);
  input.amountCommitmentX = x;
  input.amountCommitmentY = y;

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    new Uint8Array(wasm),
    new Uint8Array(zkey)
  );

  if (publicSignals.length !== 7) {
    throw new Error(`expected 7 public signals, got ${publicSignals.length}`);
  }

  const verified = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!verified) {
    throw new Error("groth16.verify returned false");
  }

  console.log("public signals:", publicSignals.length);
  console.log("verified:", verified);
  console.log("ok");

  // snarkjs leaves curve worker threads running after use, which keeps the
  // process alive indefinitely. Terminate them so this script actually exits.
  await globalThis.curve_bn128?.terminate();
  await globalThis.curve_bls12381?.terminate();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
