// Generate a valid claim proof for a depth-20 Merkle tree with one leaf.
//
// Strategy:
//   1. Compile circuits/src/compute_hashes.circom — a helper circuit with no
//      equality constraints (no ===). The witness calculator computes nullifier,
//      commitment, and Merkle root without throwing "Assert Failed".
//   2. Run witness calculation on the helper circuit to extract the actual hash
//      values for our test inputs.
//   3. Build the real claim input.json with correct public inputs.
//   4. Generate and verify the Groth16 claim proof.
import {execSync} from "child_process";
import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";
import * as snarkjs from "snarkjs";
import {symIndex} from "./sym.mjs";
import {commit} from "./jubjub-ref.mjs";

const CIRCOM = process.env.CIRCOM || `${process.env.HOME}/.local/bin/circom`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "../build");
const SNJ = path.join(HERE, "../node_modules/.bin/snarkjs");
const CLAIM_WASM = path.join(BUILD, "claim_js/claim.wasm");
const CLAIM_ZKEY = path.join(BUILD, "claim.zkey");
const CLAIM_VK = path.join(BUILD, "claim_vk.json");
const CLAIM_SYM = path.join(BUILD, "claim.sym");
const HELPER_SRC = path.join(HERE, "../src/compute_hashes.circom");
const HELPER_WASM = path.join(BUILD, "compute_hashes_js/compute_hashes.wasm");
const HELPER_SYM = path.join(BUILD, "compute_hashes.sym");

// ── test inputs (arbitrary, deterministic) ───────────────────────────────────
const SECRET = "12345";
const RECIPIENT_DIGEST = "42";  // small test value (< BLS12-381 r)
const AMOUNT = "10";            // raw stroop value for test
const TOKEN_ID = "0";           // 0 = USDC
const BLINDING = "999999";      // amountCommitment blinding factor (test value)
// Distinct non-zero siblings, and indices that alternate left/right, so the
// Merkle selector in claim.circom (and its mirror in compute_hashes.circom)
// is exercised both ways rather than only ever taking the "current is left"
// branch.
const PATH_ELEMENTS = Array.from({length: 20}, (_, i) => String(1000 + i));
const PATH_INDICES = Array.from({length: 20}, (_, i) => i % 2);

// ── step 1: compile the helper circuit (wasm only, no r1cs/zkey needed) ──────
// Recompiled whenever the source is newer than the wasm, not just when the wasm
// is missing. build/*_js/ is gitignored, so the wasm is a local artifact that
// outlives the source it was built from: an existing-but-stale one used to be
// picked up silently, and the run failed several steps later with "Not all
// inputs have been set" instead of naming the real problem.
const helperStale =
  !fs.existsSync(HELPER_WASM) ||
  fs.statSync(HELPER_SRC).mtimeMs > fs.statSync(HELPER_WASM).mtimeMs;
if (helperStale) {
  console.log("compiling helper circuit (compute_hashes.circom)...");
  execSync(
    `${CIRCOM} ${HELPER_SRC} --wasm --sym -p bls12381 -o ${BUILD}`,
    {stdio: "inherit"}
  );
} else {
  console.log("helper wasm is up to date, skipping compile.");
}

// ── step 2: run helper witness to extract nullifier and root ──────────────────
// The helper takes `amount`, so each test vector with a different amount needs
// its own run: the amount is inside the Poseidon commitment preimage and so
// changes the Merkle root too. Isolating the range check requires a
// self-consistent root, otherwise an out-of-range vector fails on a root
// mismatch instead of on Num2Bits.
const helperInputPath = path.join(BUILD, "_helper_input.json");
const helperWtnsPath = path.join(BUILD, "_helper.wtns");
const helperWtnsJsonPath = path.join(BUILD, "_helper_witness.json");
const helperSigIdx = symIndex(HELPER_SYM);

// The Pedersen (Jubjub) commitment comes from the off-circuit reference in
// jubjub-ref.mjs, which circuits/test/jubjub.test.mjs pins against the
// in-circuit PedersenCommit gadget (23 tests). The helper circuit does not
// compute it: see the note in src/compute_hashes.circom.
function pedersen(amount, blinding) {
  const point = commit(amount, blinding);
  return {
    amountCommitmentX: point.x.toString(),
    amountCommitmentY: point.y.toString(),
  };
}

/** Full claim input (public + private) for one amount/blinding pair. */
function claimInputFor(amount, blinding) {
  fs.writeFileSync(helperInputPath, JSON.stringify({
    secret: SECRET,
    recipientDigest: RECIPIENT_DIGEST,
    amount,
    tokenId: TOKEN_ID,
    pathElements: PATH_ELEMENTS,
    pathIndices: PATH_INDICES,
  }));
  execSync(`${SNJ} wtns calculate ${HELPER_WASM} ${helperInputPath} ${helperWtnsPath}`, {stdio: "pipe"});
  execSync(`${SNJ} wtns export json ${helperWtnsPath} ${helperWtnsJsonPath}`, {stdio: "pipe"});
  const witness = JSON.parse(fs.readFileSync(helperWtnsJsonPath, "utf8"));

  const sig = (name) => {
    const idx = helperSigIdx[name];
    if (idx === undefined) throw new Error(`signal not found in helper .sym: ${name}`);
    return witness[idx];
  };

  return {
    root: sig("main.root"),
    nullifier: sig("main.nullifier"),
    recipientDigest: RECIPIENT_DIGEST,
    amount,
    tokenId: TOKEN_ID,
    ...pedersen(amount, blinding),
    secret: SECRET,
    pathElements: PATH_ELEMENTS,
    pathIndices: PATH_INDICES,
    blinding,
  };
}

console.log("computing helper witness...");
const realInput = claimInputFor(AMOUNT, BLINDING);

console.log(`nullifier:        ${realInput.nullifier}`);
console.log(`root:             ${realInput.root}`);
console.log(`amountCommitmentX: ${realInput.amountCommitmentX}`);
console.log(`amountCommitmentY: ${realInput.amountCommitmentY}`);
console.log(`pathElements[0]:  ${realInput.pathElements[0]}`);
console.log(`pathElements[1]:  ${realInput.pathElements[1]}`);

// ── step 3: build real claim input ───────────────────────────────────────────
const inputPath = path.join(BUILD, "claim_input.json");
const wtnsPath = path.join(BUILD, "claim.wtns");
const proofPath = path.join(BUILD, "claim_proof.json");
const publicPath = path.join(BUILD, "claim_public.json");

fs.writeFileSync(inputPath, JSON.stringify(realInput, null, 2));

// ── step 4: witness + prove + verify ─────────────────────────────────────────
console.log("generating claim witness...");
execSync(`${SNJ} wtns calculate ${CLAIM_WASM} ${inputPath} ${wtnsPath}`, {
  stdio: "inherit",
});

console.log("proving...");
execSync(`${SNJ} groth16 prove ${CLAIM_ZKEY} ${wtnsPath} ${proofPath} ${publicPath}`, {
  stdio: "inherit",
});

console.log("verifying off-chain...");
execSync(`${SNJ} groth16 verify ${CLAIM_VK} ${publicPath} ${proofPath}`, {
  stdio: "inherit",
});

// ── step 5: the negative + boundary test vectors (BENCHMARK.md §7) ───────────
// These are regenerated alongside the valid proof on purpose. They were once
// written by hand for the 6-public-input Poseidon shape and went stale in the
// Pedersen swap: the committed boundary proof stopped verifying against
// claim_vk.json, and nothing caught it because nothing regenerated them.
const boundaryInputPath = path.join(BUILD, "claim_input_boundary.json");
const boundaryWtnsPath = path.join(BUILD, "claim_boundary.wtns");
const boundaryProofPath = path.join(BUILD, "claim_boundary_proof.json");
const boundaryPublicPath = path.join(BUILD, "claim_boundary_public.json");
const outOfRangePath = path.join(BUILD, "claim_input_outofrange.json");
const tamperedPath = path.join(BUILD, "claim_public_tampered_commitment.json");
const tamperedYPath = path.join(BUILD, "claim_public_tampered_commitment_cy.json");

const AMOUNT_MAX = (1n << 64n) - 1n;  // AMOUNT_BITS = 64 in claim.circom

// The source line each side of the expected out-of-range call path sits on,
// read out of the circuit rather than hardcoded (same technique as
// test/jubjub.test.mjs's circuitLineOf/failsAt). `amount` is decomposed by
// Num2Bits at two different call sites (claim.circom's own amountBits, and
// PedersenCommit's internal amountBits); witness calculation stops at the
// first failure, and PedersenCommit's runs first, so pinning to it (and not
// just any Num2Bits failure) also rules out PedersenCommit's unrelated
// Num2Bits(251) over `blinding`.
function circuitLineOf(filePath, needle) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`${filePath} no longer contains "${needle}"`);
  return i + 1;
}
const PEDERSEN_AMOUNT_LINE = circuitLineOf(
  path.join(HERE, "../src/jubjub/pedersen_commit.circom"),
  "amountBits.in <== amount;",
);
const CLAIM_COMMITTER_LINE = circuitLineOf(
  path.join(HERE, "../src/claim.circom"),
  "component amountCommitter = PedersenCommit();",
);

// (a) boundary: amount = 2^64 - 1 must still prove and verify, so the bound is
//     not off by one.
console.log("\n[vector] boundary amount 2^64-1: proving...");
fs.writeFileSync(
  boundaryInputPath,
  JSON.stringify(claimInputFor(AMOUNT_MAX.toString(), BLINDING), null, 2),
);
execSync(`${SNJ} wtns calculate ${CLAIM_WASM} ${boundaryInputPath} ${boundaryWtnsPath}`, {stdio: "pipe"});
execSync(`${SNJ} groth16 prove ${CLAIM_ZKEY} ${boundaryWtnsPath} ${boundaryProofPath} ${boundaryPublicPath}`, {stdio: "pipe"});
execSync(`${SNJ} groth16 verify ${CLAIM_VK} ${boundaryPublicPath} ${boundaryProofPath}`, {stdio: "inherit"});

// (b) out of range: amount = 2^64, self-consistent root and commitment so the
//     ONLY thing wrong is the range. Must fail at witness generation, i.e. no
//     proof can be constructed at all.
console.log("[vector] out-of-range amount 2^64: expecting witness failure...");
const outOfRange = claimInputFor((1n << 64n).toString(), BLINDING);
fs.writeFileSync(outOfRangePath, JSON.stringify(outOfRange, null, 2));
let outOfRangeRejected = false;
try {
  execSync(`${SNJ} wtns calculate ${CLAIM_WASM} ${outOfRangePath} ${path.join(BUILD, "_outofrange.wtns")}`, {stdio: "pipe"});
} catch (e) {
  // Pin the failure to the exact call path (Claim's amountCommitter ->
  // PedersenCommit's amountBits -> Num2Bits), not just any Num2Bits failure
  // anywhere in the circuit.
  const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  const pinned =
    /template Num2Bits_\d+ line:/.test(out) &&
    new RegExp(`template PedersenCommit_\\d+ line: ${PEDERSEN_AMOUNT_LINE}\\b`).test(out) &&
    new RegExp(`template Claim_\\d+ line: ${CLAIM_COMMITTER_LINE}\\b`).test(out);
  if (!pinned) {
    throw new Error(`out-of-range vector failed, but not at the expected amount Num2Bits site:\n${out}`);
  }
  outOfRangeRejected = true;
}
fs.rmSync(path.join(BUILD, "_outofrange.wtns"), {force: true});
if (!outOfRangeRejected) {
  throw new Error("amount = 2^64 produced a witness: the range proof is not binding");
}

// (c, d) tampered commitment: the valid proof's public signals with one
//     Pedersen coordinate incremented. Same proof, so verify must return FALSE.
//
//     snarkjs is called as a library here, not through the CLI. The CLI exits
//     non-zero for a rejected proof AND for a missing file, a malformed vk, or
//     an argument typo, so "it threw" was never evidence that the commitment is
//     bound: this block used to pass if the vk path went stale. groth16.verify()
//     returns a boolean, which is the thing actually being asserted.
const vkJson = JSON.parse(fs.readFileSync(CLAIM_VK, "utf8"));
const proofJson = JSON.parse(fs.readFileSync(proofPath, "utf8"));
const validSignals = JSON.parse(fs.readFileSync(publicPath, "utf8"));

// Control. A `false` below proves nothing unless the same call returns `true`
// for the untouched signals, on the same vk and the same proof object.
const baseline = await snarkjs.groth16.verify(vkJson, validSignals, proofJson);
if (baseline !== true) {
  throw new Error(
    `in-process verify returned ${baseline} for the UNTAMPERED signals; ` +
    "the tampered vectors below would be meaningless"
  );
}
console.log("[control] untampered public signals verify:", baseline);

// [root, nullifier, recipientDigest, amount, tokenId, cx, cy]
const COMMITMENT_INDEX = {cx: 5, cy: 6};
for (const [coord, index, outPath] of [
  ["cx", COMMITMENT_INDEX.cx, tamperedPath],
  ["cy", COMMITMENT_INDEX.cy, tamperedYPath],
]) {
  const tampered = validSignals.slice();
  tampered[index] = (BigInt(tampered[index]) + 1n).toString();
  if (tampered[index] === validSignals[index]) {
    throw new Error(`tampering ${coord} (index ${index}) did not change the signal`);
  }
  fs.writeFileSync(outPath, JSON.stringify(tampered, null, 1));

  const ok = await snarkjs.groth16.verify(vkJson, tampered, proofJson);
  console.log(`[vector] tampered commitment ${coord} (index ${index}): verify ->`, ok);
  if (ok !== false) {
    throw new Error(
      `tampered commitment ${coord} verified as ${ok}: that coordinate is not bound ` +
      "to the proof"
    );
  }
}

// ── cleanup temp files ────────────────────────────────────────────────────────
fs.rmSync(helperInputPath, {force: true});
fs.rmSync(helperWtnsPath, {force: true});
fs.rmSync(helperWtnsJsonPath, {force: true});

console.log("\nTest proof written to circuits/build/:");
console.log("  claim_proof.json");
console.log("  claim_public.json");
console.log("Test vectors:");
console.log("  claim_input_boundary.json / claim_boundary_{proof,public}.json  (valid at 2^64-1)");
console.log("  claim_input_outofrange.json                                    (no witness at 2^64)");
console.log("  claim_public_tampered_commitment.json                          (cx, verify false)");
console.log("  claim_public_tampered_commitment_cy.json                       (cy, verify false)");
console.log("public signals:", validSignals);

// snarkjs leaves its wasm curve workers running, so an otherwise finished
// script would hang here instead of exiting.
await globalThis.curve_bls12381?.terminate();
