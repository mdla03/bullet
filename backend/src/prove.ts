// Generates a Groth16 claim proof against the CURRENT Merkle tree state.
// Steps:
//   1. Compute commitment + nullifier in JS Poseidon (matches the circuit).
//   2. Look up this leaf's index in leaves.ts (inserted by /commitment).
//   3. Get the real Merkle path from tree.ts.
//   4. Invoke snarkjs (child process) with the claim circuit to produce the proof.
//   5. Encode proof bytes for Soroban.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeCommitment, computeNullifier } from "./commitment.js";
import * as leaves from "./leaves.js";
import * as tree from "./tree.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../");
const SNARKJS = path.join(ROOT, "circuits/node_modules/.bin/snarkjs");
const CLAIM_WASM = path.join(ROOT, "circuits/build/claim_js/claim.wasm");
const CLAIM_ZKEY = path.join(ROOT, "circuits/build/claim.zkey");

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
    fs.existsSync(CLAIM_ZKEY)
  );
}

export function generateProof(
  secret: string,
  recipientDigest: string,
  denom: string
): ProveResult {
  // (1) + (2) — deterministic; also validates inputs (throws on bad format/denom).
  const commitment = computeCommitment(secret, recipientDigest, denom);
  const nullifier = computeNullifier(secret);
  const leafIndex = leaves.indexOf(commitment);
  if (leafIndex === -1) {
    throw new Error(
      "commitment not found in tree — /commitment must be called before /prove"
    );
  }

  // (3) — real path from the current tree state.
  const p = tree.pathFor(leafIndex);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zeekpay-prove-"));
  try {
    // (4) — Groth16 prove via snarkjs subprocess.
    const claimInput = {
      root: p.root,
      nullifier,
      recipientDigest,
      denom,
      secret,
      pathElements: p.pathElements,
      pathIndices: p.pathIndices,
    };
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

    // (5) — convert to Soroban byte layout.
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
    const g1 = (pt: [string, string, string]): string => be(pt[0], 48) + be(pt[1], 48);
    const g2 = (pt: [[string, string], [string, string], [string, string]]): string =>
      be(pt[0][1], 48) + be(pt[0][0], 48) + be(pt[1][1], 48) + be(pt[1][0], 48);
    const fr = (dec: string): string => be(dec, 32);

    return {
      proof_a: g1(proof.pi_a),
      proof_b: g2(proof.pi_b),
      proof_c: g1(proof.pi_c),
      nullifier: fr(nullifier),
      root: fr(p.root),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
