import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../");
const SNARKJS = path.join(ROOT, "circuits/node_modules/.bin/snarkjs");
const WASM = path.join(
  ROOT,
  "circuits/build/compute_hashes_js/compute_hashes.wasm"
);
// witness index for main.pathHashes[0] = Poseidon([secret, recipientDigest, denom])
const COMMITMENT_IDX = 27;

const BLS_R =
  52435875175126190479447740508185965837690552500527637822603658699938581184513n;

export function isCircuitsReady(): boolean {
  return fs.existsSync(SNARKJS) && fs.existsSync(WASM);
}

function isValidFr(s: string): boolean {
  try {
    const n = BigInt(s);
    return n >= 0n && n < BLS_R;
  } catch {
    return false;
  }
}

export function computeCommitment(
  secret: string,
  recipientDigest: string,
  denom: string
): string {
  if (!isValidFr(secret) || !isValidFr(recipientDigest) || !isValidFr(denom)) {
    throw new Error("invalid field element: must be decimal < BLS12-381 r");
  }

  const id = randomUUID();
  const tmp = os.tmpdir();
  const inFile = path.join(tmp, `zk_${id}_in.json`);
  const wtnsFile = path.join(tmp, `zk_${id}.wtns`);
  const jsonFile = path.join(tmp, `zk_${id}_w.json`);

  try {
    fs.writeFileSync(
      inFile,
      JSON.stringify({ secret, recipientDigest, denom })
    );
    execSync(`"${SNARKJS}" wtns calculate "${WASM}" "${inFile}" "${wtnsFile}"`, {
      stdio: "pipe",
    });
    execSync(
      `"${SNARKJS}" wtns export json "${wtnsFile}" "${jsonFile}"`,
      { stdio: "pipe" }
    );
    const witness = JSON.parse(fs.readFileSync(jsonFile, "utf8")) as string[];
    return witness[COMMITMENT_IDX];
  } finally {
    for (const f of [inFile, wtnsFile, jsonFile]) fs.rmSync(f, { force: true });
  }
}
