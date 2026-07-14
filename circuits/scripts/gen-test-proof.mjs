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
const helperInput = {
  secret: SECRET,
  recipientDigest: RECIPIENT_DIGEST,
  amount: AMOUNT,
  tokenId: TOKEN_ID,
};
const helperInputPath = path.join(BUILD, "_helper_input.json");
const helperWtnsPath = path.join(BUILD, "_helper.wtns");
const helperWtnsJsonPath = path.join(BUILD, "_helper_witness.json");

fs.writeFileSync(helperInputPath, JSON.stringify(helperInput));

console.log("computing helper witness...");
execSync(
  `${SNJ} wtns calculate ${HELPER_WASM} ${helperInputPath} ${helperWtnsPath}`,
  {stdio: "pipe"}
);
execSync(
  `${SNJ} wtns export json ${helperWtnsPath} ${helperWtnsJsonPath}`,
  {stdio: "pipe"}
);

// ── parse helper .sym to find signal indices ──────────────────────────────────
const helperSymLines = fs.readFileSync(HELPER_SYM, "utf8").trim().split("\n");
const helperSigIdx = {};
for (const line of helperSymLines) {
  const parts = line.split(",");
  if (parts.length < 4) continue;
  helperSigIdx[parts[3].trim()] = parseInt(parts[0], 10);
}

const helperWitness = JSON.parse(fs.readFileSync(helperWtnsJsonPath, "utf8"));

function getHelperSignal(name) {
  const idx = helperSigIdx[name];
  if (idx === undefined) throw new Error(`signal not found in helper .sym: ${name}`);
  return helperWitness[idx];
}

const computedNullifier = getHelperSignal("main.nullifier");
const computedRoot = getHelperSignal("main.root");

// For leaf at index 0 (left child all the way), pathElements[i] = zeroHashes[i]:
//   pathElements[0] = zeroHashes[0] = 0            (empty leaf)
//   pathElements[1] = zeroHashes[1] = Poseidon([0,0])
//   pathElements[i] = zeroHashes[i]  for i=0..19
//
// Circom optimizes away the constant signal zeroHashes[0]=0, so the sym file
// maps "main.zeroHashes[i]" to the witness slot for zeroHashes[i+1] (one-off).
// Compensate: pathElements[0]="0" (hardcoded), pathElements[i+1]=sym[i] for i=0..18.
const pathElements = ["0"];
for (let i = 0; i < 19; i++) {
  pathElements.push(getHelperSignal(`main.zeroHashes[${i}]`));
}

console.log(`nullifier:       ${computedNullifier}`);
console.log(`root:            ${computedRoot}`);
console.log(`pathElements[0]: ${pathElements[0]}`);
console.log(`pathElements[1]: ${pathElements[1]}`);

// ── step 3: build real claim input ───────────────────────────────────────────
const realInput = {
  root: computedRoot,
  nullifier: computedNullifier,
  recipientDigest: RECIPIENT_DIGEST,
  amount: AMOUNT,
  tokenId: TOKEN_ID,
  secret: SECRET,
  pathElements,
  pathIndices: PATH_INDICES,
};

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

// ── cleanup temp files ────────────────────────────────────────────────────────
fs.rmSync(helperInputPath, {force: true});
fs.rmSync(helperWtnsPath, {force: true});
fs.rmSync(helperWtnsJsonPath, {force: true});

console.log("\nTest proof written to circuits/build/:");
console.log("  claim_proof.json");
console.log("  claim_public.json");
console.log("public signals:", JSON.parse(fs.readFileSync(publicPath, "utf8")));
