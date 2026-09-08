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
const PATH_ELEMENTS = Array(20).fill("0");  // all siblings are zero
const PATH_INDICES = Array(20).fill(0);     // leaf is at index 0 (always left)

// ── step 1: compile the helper circuit (wasm only, no r1cs/zkey needed) ──────
if (!fs.existsSync(HELPER_WASM)) {
  console.log("compiling helper circuit (compute_hashes.circom)...");
  execSync(
    `${CIRCOM} ${HELPER_SRC} --wasm --sym -p bls12381 -o ${BUILD}`,
    {stdio: "inherit"}
  );
} else {
  console.log("helper wasm exists, skipping compile.");
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
// in-circuit PedersenCommit gadget (21 tests). The helper circuit does not
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
  }));
  execSync(`${SNJ} wtns calculate ${HELPER_WASM} ${helperInputPath} ${helperWtnsPath}`, {stdio: "pipe"});
  execSync(`${SNJ} wtns export json ${helperWtnsPath} ${helperWtnsJsonPath}`, {stdio: "pipe"});
  const witness = JSON.parse(fs.readFileSync(helperWtnsJsonPath, "utf8"));

  const sig = (name) => {
    const idx = helperSigIdx[name];
    if (idx === undefined) throw new Error(`signal not found in helper .sym: ${name}`);
    return witness[idx];
  };

  // For leaf at index 0 (left child all the way), pathElements[i] = zeroHashes[i]:
  //   pathElements[0] = zeroHashes[0] = 0            (empty leaf)
  //   pathElements[1] = zeroHashes[1] = Poseidon([0,0])
  //   pathElements[i] = zeroHashes[i]  for i=0..19
  //
  // Circom optimizes away the constant signal zeroHashes[0]=0, so the sym file
  // maps "main.zeroHashes[i]" to the witness slot for zeroHashes[i+1] (one-off).
  // Compensate: pathElements[0]="0" (hardcoded), pathElements[i+1]=sym[i] for i=0..18.
  const pathElements = ["0"];
  for (let i = 0; i < 19; i++) pathElements.push(sig(`main.zeroHashes[${i}]`));

  return {
    root: sig("main.root"),
    nullifier: sig("main.nullifier"),
    recipientDigest: RECIPIENT_DIGEST,
    amount,
    tokenId: TOKEN_ID,
    ...pedersen(amount, blinding),
    secret: SECRET,
    pathElements,
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

const AMOUNT_MAX = (1n << 64n) - 1n;  // AMOUNT_BITS = 64 in claim.circom

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
  // Pin the failure site: it has to be the Num2Bits range decomposition, not
  // some unrelated unsatisfied constraint that would pass for the wrong reason.
  const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  if (!/Num2Bits/.test(out)) {
    throw new Error(`out-of-range vector failed, but not in Num2Bits:\n${out}`);
  }
  outOfRangeRejected = true;
}
fs.rmSync(path.join(BUILD, "_outofrange.wtns"), {force: true});
if (!outOfRangeRejected) {
  throw new Error("amount = 2^64 produced a witness: the range proof is not binding");
}

// (c) tampered commitment: the valid proof's public signals with the Pedersen
//     x coordinate incremented. Same proof, so verify must return false.
const tampered = JSON.parse(fs.readFileSync(publicPath, "utf8"));
const X_INDEX = 5;  // [root, nullifier, recipientDigest, amount, tokenId, cx, cy]
tampered[X_INDEX] = (BigInt(tampered[X_INDEX]) + 1n).toString();
fs.writeFileSync(tamperedPath, JSON.stringify(tampered, null, 1));
console.log("[vector] tampered commitment x: expecting verify false...");
let tamperRejected = false;
try {
  execSync(`${SNJ} groth16 verify ${CLAIM_VK} ${tamperedPath} ${proofPath}`, {stdio: "pipe"});
} catch {
  tamperRejected = true;
}
if (!tamperRejected) {
  throw new Error("tampered commitment still verified: the commitment is not bound");
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
console.log("  claim_public_tampered_commitment.json                          (verify false)");
console.log("public signals:", JSON.parse(fs.readFileSync(publicPath, "utf8")));
