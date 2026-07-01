import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../");
const SNARKJS = path.join(ROOT, "circuits/node_modules/.bin/snarkjs");
const CLAIM_WASM = path.join(ROOT, "circuits/build/claim_js/claim.wasm");
const CLAIM_ZKEY = path.join(ROOT, "circuits/build/claim.zkey");
const HELPER_WASM = path.join(ROOT, "circuits/build/compute_hashes_js/compute_hashes.wasm");
const HELPER_SYM = path.join(ROOT, "circuits/build/compute_hashes.sym");

const BLS_R = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

export interface ProveResult {
  proof_a: string;   // 192-char hex — G1 (96 bytes BE X||Y)
  proof_b: string;   // 384-char hex — G2 (192 bytes BE X_c1||X_c0||Y_c1||Y_c0)
  proof_c: string;   // 192-char hex — G1 (96 bytes BE X||Y)
  nullifier: string; // 64-char hex — Fr (32 bytes BE)
  root: string;      // 64-char hex — Fr (32 bytes BE)
}

export function isProveReady(): boolean {
  return (
    fs.existsSync(SNARKJS) &&
    fs.existsSync(CLAIM_WASM) &&
    fs.existsSync(CLAIM_ZKEY) &&
    fs.existsSync(HELPER_WASM) &&
    fs.existsSync(HELPER_SYM)
  );
}

export function generateProof(
  secret: string,
  recipientDigest: string,
  denom: string
): ProveResult {
  const secretN = BigInt(secret);
  const rdN = BigInt(recipientDigest);
  const denomN = BigInt(denom);
  if (secretN < 0n || secretN >= BLS_R) throw new Error("secret out of BLS_R range");
  if (rdN < 0n || rdN >= BLS_R) throw new Error("recipientDigest out of BLS_R range");
  if (denomN !== 1n && denomN !== 10n && denomN !== 50n && denomN !== 100n)
    throw new Error("denom must be 1, 10, 50 or 100");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zeekpay-prove-"));
  try {
    // ── Step 1: helper witness — compute nullifier, root, zero-hash path ─────
    const helperInputPath = path.join(tmp, "helper_input.json");
    const helperWtnsPath = path.join(tmp, "helper.wtns");
    const helperJsonPath = path.join(tmp, "helper_witness.json");

    fs.writeFileSync(helperInputPath, JSON.stringify({ secret, recipientDigest, denom }));
    execSync(
      `"${SNARKJS}" wtns calculate "${HELPER_WASM}" "${helperInputPath}" "${helperWtnsPath}"`,
      { stdio: "pipe" }
    );
    execSync(
      `"${SNARKJS}" wtns export json "${helperWtnsPath}" "${helperJsonPath}"`,
      { stdio: "pipe" }
    );

    const helperWitness: string[] = JSON.parse(fs.readFileSync(helperJsonPath, "utf8"));
    const sigIdx: Record<string, number> = {};
    for (const line of fs.readFileSync(HELPER_SYM, "utf8").trim().split("\n")) {
      const parts = line.split(",");
      if (parts.length >= 4) sigIdx[parts[3].trim()] = parseInt(parts[0], 10);
    }
    const get = (name: string): string => {
      const idx = sigIdx[name];
      if (idx === undefined) throw new Error(`signal not found in helper sym: ${name}`);
      return helperWitness[idx];
    };

    const nullifier = get("main.nullifier");
    const root = get("main.root");

    // zeroHashes[0]=0 is a constant, optimized away; sym[zeroHashes[i]] → slot for zeroHashes[i+1]
    const pathElements = ["0"];
    for (let i = 0; i < 19; i++) pathElements.push(get(`main.zeroHashes[${i}]`));
    const pathIndices = Array(20).fill(0);

    // ── Step 2: claim witness + Groth16 prove ────────────────────────────────
    const claimInput = { root, nullifier, recipientDigest, denom, secret, pathElements, pathIndices };
    const claimInputPath = path.join(tmp, "claim_input.json");
    const claimWtnsPath = path.join(tmp, "claim.wtns");
    const claimProofPath = path.join(tmp, "claim_proof.json");
    const claimPublicPath = path.join(tmp, "claim_public.json");

    fs.writeFileSync(claimInputPath, JSON.stringify(claimInput));
    execSync(
      `"${SNARKJS}" wtns calculate "${CLAIM_WASM}" "${claimInputPath}" "${claimWtnsPath}"`,
      { stdio: "pipe" }
    );
    execSync(
      `"${SNARKJS}" groth16 prove "${CLAIM_ZKEY}" "${claimWtnsPath}" "${claimProofPath}" "${claimPublicPath}"`,
      { stdio: "pipe" }
    );

    // ── Step 3: convert to Soroban byte layout ───────────────────────────────
    const proof = JSON.parse(fs.readFileSync(claimProofPath, "utf8")) as {
      pi_a: [string, string, string];
      pi_b: [[string, string], [string, string], [string, string]];
      pi_c: [string, string, string];
    };

    const be = (dec: string, bytes: number): string => {
      const h = BigInt(dec).toString(16);
      if (h.length > bytes * 2) throw new Error(`value overflow: ${dec}`);
      return h.padStart(bytes * 2, "0");
    };
    const g1 = (p: [string, string, string]): string => be(p[0], 48) + be(p[1], 48);
    const g2 = (p: [[string, string], [string, string], [string, string]]): string =>
      be(p[0][1], 48) + be(p[0][0], 48) + be(p[1][1], 48) + be(p[1][0], 48);
    const fr = (d: string): string => be(d, 32);

    return {
      proof_a: g1(proof.pi_a),
      proof_b: g2(proof.pi_b),
      proof_c: g1(proof.pi_c),
      nullifier: fr(nullifier),
      root: fr(root),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
