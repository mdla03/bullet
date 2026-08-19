// Generates test vectors for joinsplit.circom and checks each one behaves as
// intended: the valid vector must produce a witness, and every adversarial
// vector must fail, at the constraint it is aimed at.
//
// Hashes come from joinsplit_hashes.circom rather than circomlibjs, because
// the real circuits compile under -p bls12381 while circomlibjs computes
// Poseidon over BN254. JS-side hashes would silently not match.
//
// Run: node circuits/scripts/gen-joinsplit-vectors.mjs
// Needs circom on PATH or $CIRCOM. Everything is local, no network.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS = path.resolve(HERE, "..");
const SRC = path.join(CIRCUITS, "src");
const BUILD = path.join(CIRCUITS, "build");
const SNJ = path.join(CIRCUITS, "node_modules/.bin/snarkjs");
const CIRCOM = process.env.CIRCOM ?? path.join(process.env.HOME, ".local/bin/circom");

const DEPTH = 20;
const TOKEN_ID = "0";

fs.mkdirSync(BUILD, { recursive: true });

function sh(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString();
}

// ── compile both circuits ────────────────────────────────────────────────────
for (const name of ["joinsplit", "joinsplit_hashes"]) {
  const wasm = path.join(BUILD, `${name}_js`, `${name}.wasm`);
  if (!fs.existsSync(wasm)) {
    console.log(`compiling ${name}...`);
    sh(`"${CIRCOM}" "${path.join(SRC, `${name}.circom`)}" --wasm --sym -p bls12381 -o "${BUILD}"`);
  }
}

// ── run the helper and read its signals back out of the witness ──────────────
// Two real notes at leaf indices 0 and 1. Balance: 100 + 50 = 120 + 30.
const NOTES = {
  secret: ["11111", "22222"],
  recipientDigest: ["42", "43"],
  value: ["100", "50"],
  leafIndex: ["0", "1"],
  secretOut: ["33333", "44444"],
  recipientDigestOut: ["44", "45"],
  valueOut: ["120", "30"],
  tokenId: TOKEN_ID,
};

const helperIn = path.join(BUILD, "_js_helper_input.json");
const helperWtns = path.join(BUILD, "_js_helper.wtns");
const helperJson = path.join(BUILD, "_js_helper_witness.json");

fs.writeFileSync(helperIn, JSON.stringify(NOTES));
console.log("computing helper witness...");
sh(`"${SNJ}" wtns calculate "${path.join(BUILD, "joinsplit_hashes_js/joinsplit_hashes.wasm")}" "${helperIn}" "${helperWtns}"`);
sh(`"${SNJ}" wtns export json "${helperWtns}" "${helperJson}"`);

const symIdx = {};
for (const line of fs.readFileSync(path.join(BUILD, "joinsplit_hashes.sym"), "utf8").trim().split("\n")) {
  const p = line.split(",");
  if (p.length >= 4) symIdx[p[3].trim()] = parseInt(p[0], 10);
}
const witness = JSON.parse(fs.readFileSync(helperJson, "utf8"));
const sig = (name) => {
  const i = symIdx[name];
  if (i === undefined) throw new Error(`signal not in .sym: ${name}`);
  return witness[i];
};

const inCommitment = [sig("main.inCommitment[0]"), sig("main.inCommitment[1]")];
const nullifier = [sig("main.nullifier[0]"), sig("main.nullifier[1]")];
const outCommitment = [sig("main.outCommitment[0]"), sig("main.outCommitment[1]")];
const zeroHash = Array.from({ length: DEPTH }, (_, k) => sig(`main.zeroHash[${k}]`));
const root = sig("main.root");

console.log(`root: ${root}`);

// Leaf 0 sits left of leaf 1; every level above pairs with an empty subtree.
const pathFor = (i) => ({
  pathElements: [i === 0 ? inCommitment[1] : inCommitment[0], ...zeroHash.slice(1)],
  pathIndices: [i === 0 ? 0 : 1, ...Array(DEPTH - 1).fill(0)],
});

const base = () => ({
  root,
  nullifierPub: [...nullifier],
  commitmentOutPub: [...outCommitment],
  publicDeposit: "0",
  publicWithdraw: "0",
  tokenId: TOKEN_ID,
  secret: [...NOTES.secret],
  recipientDigest: [...NOTES.recipientDigest],
  value: [...NOTES.value],
  leafIndex: [...NOTES.leafIndex],
  pathElements: [pathFor(0).pathElements, pathFor(1).pathElements],
  pathIndices: [pathFor(0).pathIndices, pathFor(1).pathIndices],
  isDummy: [0, 0],
  secretOut: [...NOTES.secretOut],
  recipientDigestOut: [...NOTES.recipientDigestOut],
  valueOut: [...NOTES.valueOut],
});

// ── the vectors ──────────────────────────────────────────────────────────────
// `expect` is what a correct circuit must do. `aims at` names the constraint
// each adversarial vector is meant to trip, so a test passing for the wrong
// reason is visible rather than silently reassuring.
const vectors = [
  {
    name: "valid",
    expect: "pass",
    aim: "the honest path: 100 + 50 == 120 + 30",
    input: base(),
  },
  {
    name: "balance_violation",
    expect: "fail",
    expectAt: "JoinSplit:182",
    aim: "balance: outputs exceed inputs by 1",
    input: (() => {
      const v = base();
      v.valueOut = ["121", "30"];
      // Recomputed below, since the commitment must match the inflated value.
      v.__recomputeOut = true;
      return v;
    })(),
  },
  {
    name: "dummy_with_value",
    expect: "fail",
    expectAt: "JoinSplit:107",
    aim: "isDummy * value === 0: a dummy carrying value",
    input: (() => {
      const v = base();
      v.isDummy = [1, 0];
      return v;
    })(),
  },
  {
    name: "leafindex_mismatch",
    expect: "fail",
    expectAt: "JoinSplit:139",
    aim: "leafIndex === path index: second nullifier for one note",
    input: (() => {
      const v = base();
      v.leafIndex = ["0", "5"];
      return v;
    })(),
  },
  {
    name: "wrong_token",
    expect: "fail",
    expectAt: "JoinSplit:133",
    aim: "tokenId binding: commitment no longer matches the tree leaf",
    input: (() => {
      const v = base();
      v.tokenId = "1";
      return v;
    })(),
  },
  {
    name: "value_out_of_range",
    expect: "fail",
    expectAt: "Num2Bits:38",
    aim: "Num2Bits(64) on an output value of 2^64",
    input: (() => {
      const v = base();
      v.valueOut = [(2n ** 64n).toString(), "30"];
      v.__recomputeOut = true;
      return v;
    })(),
  },
  {
    name: "forged_root",
    expect: "fail",
    expectAt: "JoinSplit:133",
    aim: "Merkle membership against a root nobody committed to",
    input: (() => {
      const v = base();
      v.root = (BigInt(root) + 1n).toString();
      return v;
    })(),
  },
];

// Vectors that change an output value need its commitment recomputed, or they
// would fail on the commitment check rather than the constraint they target.
for (const v of vectors) {
  if (!v.input.__recomputeOut) continue;
  delete v.input.__recomputeOut;
  const hi = { ...NOTES, valueOut: v.input.valueOut };
  fs.writeFileSync(helperIn, JSON.stringify(hi));
  sh(`"${SNJ}" wtns calculate "${path.join(BUILD, "joinsplit_hashes_js/joinsplit_hashes.wasm")}" "${helperIn}" "${helperWtns}"`);
  sh(`"${SNJ}" wtns export json "${helperWtns}" "${helperJson}"`);
  const w = JSON.parse(fs.readFileSync(helperJson, "utf8"));
  v.input.commitmentOutPub = [w[symIdx["main.outCommitment[0]"]], w[symIdx["main.outCommitment[1]"]]];
}

// ── run them ─────────────────────────────────────────────────────────────────
const JS_WASM = path.join(BUILD, "joinsplit_js/joinsplit.wasm");
let failures = 0;

console.log("");
for (const v of vectors) {
  const inPath = path.join(BUILD, `joinsplit_input_${v.name}.json`);
  fs.writeFileSync(inPath, JSON.stringify(v.input, null, 2));

  let got, detail = "";
  try {
    sh(`"${SNJ}" wtns calculate "${JS_WASM}" "${inPath}" "${path.join(BUILD, `_js_${v.name}.wtns`)}"`);
    got = "pass";
  } catch (e) {
    got = "fail";
    // The template name alone is not enough: every constraint in JoinSplit
    // reports the same one. The line number is what tells a balance failure
    // apart from a membership failure, so a vector that fails for the wrong
    // reason is visible instead of looking like a pass.
    const err = e.stderr?.toString() ?? "";
    const lines = [...err.matchAll(/Error in template (\w+?)_\d+ line: (\d+)/g)]
      .map((m) => `${m[1]}:${m[2]}`);
    detail = lines.length ? ` at ${[...new Set(lines)].join(" <- ")}` : "";
    v.failedAt = detail.trim();
  }

  let ok = got === v.expect;
  // A vector that fails at the wrong constraint is not evidence. Pin the site.
  if (ok && v.expectAt && !(v.failedAt ?? "").includes(v.expectAt)) {
    ok = false;
    detail += `  [WRONG SITE: wanted ${v.expectAt}]`;
  }
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${v.name.padEnd(20)} expected ${v.expect}, got ${got}${detail}`);
  console.log(`      aims at: ${v.aim}`);
}

console.log("");
if (failures) {
  console.error(`${failures} vector(s) did not behave as intended`);
  process.exit(1);
}
console.log(`all ${vectors.length} vectors behaved as intended`);
