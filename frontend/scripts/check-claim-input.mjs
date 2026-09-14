// Sanity check for the served (frontend/public/circuits) claim.wasm/claim.zkey:
// prove circuits/build/claim_input.json with a fresh blinding, verify against
// circuits/build/claim_vk.json, and assert the 7-public-input shape the
// production claim flow (prove_browser.ts) expects.
//
// Run: node frontend/scripts/check-claim-input.mjs

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as snarkjs from "snarkjs";
import { commit, randomBlinding } from "../../circuits/scripts/jubjub-ref.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const WASM_PATH = path.join(root, "frontend", "public", "circuits", "claim.wasm");
const ZKEY_PATH = path.join(root, "frontend", "public", "circuits", "claim.zkey");
const INPUT_PATH = path.join(root, "circuits", "build", "claim_input.json");
const VK_PATH = path.join(root, "circuits", "build", "claim_vk.json");

function pedersenCommit(amount, blinding) {
  const c = commit(BigInt(amount), BigInt(blinding));
  return { x: c.x.toString(), y: c.y.toString() };
}

// Self-check against the pinned sample also asserted in
// circuits/scripts/jubjub-ref.mjs's own self-check and in
// frontend/src/lib/jubjub_commit.ts's noble-based commit: commit(37, 12345)
// must equal this fixed point, or the shared reference has drifted.
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

  input.blinding = randomBlinding().toString();
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
