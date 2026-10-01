// Send witness (joinsplit.ts) and note nullifier (commitment.ts) tests.
//
// The witness is also run through the real joinsplit.wasm served from
// public/circuits/, so a JS hash or layout that drifts from the circuit fails
// here rather than on-chain as InvalidProof.
//
// Run: npx tsx --test src/lib/joinsplit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error snarkjs has no bundled types.
import * as snarkjs from "snarkjs";
import { buildSendWitness } from "./joinsplit";
import { noteNullifier } from "./commitment";
import { assertNoteAddressedTo, computeRecipientDigest } from "./recipient";
import { poseidon } from "./poseidon";

const FRONTEND = path.resolve(__dirname, "../..");
const CIRCUITS_BUILD = path.resolve(FRONTEND, "../circuits/build");

// Valid, distinct G-addresses (circuits/scripts/stellar-digest.mjs).
const SENDER = "GDIIEBJPCOP2FHJM4TCW6KBPJXQOCHH64ISSWEFJRMVJLHBL5UMGHDO7";
const RECIPIENT = "GBKZT2BEAZVYSMQFNBV664OAREETM3MUII4VZO4RCI64KLMAQ2R2ZQQK";
const AMOUNT = 12_345_678n;
const TOKEN = 2; // non-zero, so a dropped or defaulted tokenId is visible
const ROOT = "4242";

// Distinct deterministic "random" secrets, one per call.
function seq() {
  let i = 0;
  return () => (++i).toString(16).padStart(2, "0").repeat(31).padStart(64, "0");
}

const build = () =>
  buildSendWitness({
    owner: SENDER,
    recipient: RECIPIENT,
    amount: AMOUNT,
    tokenId: TOKEN,
    root: ROOT,
    randomHex: seq(),
  });

test("ownerDigest is the sender's address digest", async () => {
  const w = await build();
  const sender = (await computeRecipientDigest(SENDER)).toString();
  assert.equal(w.ownerDigest, sender);
  assert.equal(w.input.ownerDigest, sender);
  assert.equal(w.publicSignals[8], sender);
});

test("the real output commitment uses the recipient's address digest", async () => {
  const w = await build();
  const recipient = (await computeRecipientDigest(RECIPIENT)).toString();
  assert.notEqual(recipient, w.ownerDigest);
  const secretOut = w.input.secretOut as string[];
  assert.equal((w.input.recipientDigestOut as string[])[0], recipient);
  assert.equal(w.note.recipientDigest, recipient);
  assert.equal(
    w.commitments[0],
    poseidon([secretOut[0], recipient, AMOUNT.toString(), String(TOKEN)])
  );
  assert.equal(BigInt("0x" + w.note.secretHex).toString(), secretOut[0]);
});

test("publicDeposit is the amount, nothing is withdrawn, value is conserved", async () => {
  const w = await build();
  assert.equal(w.input.publicDeposit, AMOUNT.toString());
  assert.equal(w.input.publicWithdraw, "0");
  assert.equal(w.publicSignals[5], AMOUNT.toString());
  assert.equal(w.publicSignals[6], "0");
  assert.deepEqual(w.input.valueOut, [AMOUNT.toString(), "0"]);
  assert.deepEqual(w.input.isDummy, ["1", "1"]);
});

test("dummy nullifiers are distinct and use the note nullifier formula", async () => {
  const w = await build();
  const secrets = w.input.secret as string[];
  assert.notEqual(w.nullifiers[0], w.nullifiers[1]);
  assert.equal(w.nullifiers[0], noteNullifier(secrets[0], 0));
  assert.equal(w.nullifiers[1], noteNullifier(secrets[1], 0));
});

test("note nullifier is Poseidon([secret, leafIndex]) as the circuits compute it", () => {
  // Both vectors were accepted by the circuits: the claim input's nullifier
  // for its leafIndex, and join-split input note 0 at leaf 0.
  const claim = JSON.parse(fs.readFileSync(path.join(CIRCUITS_BUILD, "claim_input.json"), "utf8"));
  assert.notEqual(claim.leafIndex, "0", "the vector must sit at a non-zero index");
  assert.equal(noteNullifier(claim.secret, Number(claim.leafIndex)), claim.nullifier);
  assert.notEqual(noteNullifier(claim.secret, 0), claim.nullifier);

  const js = JSON.parse(
    fs.readFileSync(path.join(CIRCUITS_BUILD, "joinsplit_input_valid.json"), "utf8")
  );
  assert.equal(noteNullifier(js.secret[0], Number(js.leafIndex[0])), js.nullifierPub[0]);
});

test("the circuit accepts the send witness and derives the same public signals", async () => {
  const w = await build();
  const wasm = path.join(FRONTEND, "public/circuits/joinsplit.wasm");
  const wtns = { type: "mem" as const };
  await snarkjs.wtns.calculate(w.input, wasm, wtns);
  const signals: bigint[] = await snarkjs.wtns.exportJson(wtns);
  // Witness slot 0 is the constant 1; public signals follow in circuit order.
  assert.deepEqual(
    signals.slice(1, 1 + w.publicSignals.length).map(String),
    w.publicSignals
  );
});

test("a note is claimable only from the wallet it is addressed to", async () => {
  const w = await build();
  await assertNoteAddressedTo(RECIPIENT, w.note.recipientDigest);
  await assert.rejects(assertNoteAddressedTo(SENDER, w.note.recipientDigest), /different wallet/);
});
