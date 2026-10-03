import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBalanced,
  leafIndexFromPathIndices,
  noteCommitment,
  noteNullifier,
  type PoolNote,
} from "./pool_note";

const note = (over: Partial<PoolNote> = {}): PoolNote => ({
  secret: "11111",
  recipientDigest: "42",
  value: 100n,
  tokenId: 1,
  ...over,
});

test("nullifier is Poseidon([secret]) only, so it equals the claim-path nullifier", () => {
  // The whole double-spend fix: a note's nullifier must not depend on value,
  // digest, token or leaf index. Only the secret. Two notes that differ in
  // everything but the secret share a nullifier.
  const a = noteNullifier(note());
  const b = noteNullifier(note({ value: 999n, recipientDigest: "7", tokenId: 0, leafIndex: 5 }));
  assert.equal(a, b, "nullifier must depend on the secret alone");
  const c = noteNullifier(note({ secret: "22222" }));
  assert.notEqual(a, c, "a different secret must give a different nullifier");
});

test("commitment binds secret, digest, value and token", () => {
  const base = noteCommitment(note());
  // Each field changing must change the commitment, or notes would collide.
  assert.notEqual(base, noteCommitment(note({ secret: "22222" })));
  assert.notEqual(base, noteCommitment(note({ recipientDigest: "43" })));
  assert.notEqual(base, noteCommitment(note({ value: 101n })));
  assert.notEqual(base, noteCommitment(note({ tokenId: 0 })));
  // Stable for the same inputs.
  assert.equal(base, noteCommitment(note()));
});

test("isBalanced enforces sum(in)+deposit == sum(out)+withdraw", () => {
  const i = [note({ value: 100n }), note({ secret: "0", value: 0n })]; // one real, one dummy
  // In-pool transfer: 100 in, split 70 + 30 out, no public legs.
  assert.ok(isBalanced(i, [note({ value: 70n }), note({ value: 30n })], 0n, 0n));
  // Withdraw: 100 in, 0 out, 100 leaves the pool.
  assert.ok(isBalanced(i, [note({ value: 0n }), note({ value: 0n })], 0n, 100n));
  // Deposit: nothing in, 100 deposited, 100 as a new note.
  const dummies = [note({ secret: "0", value: 0n }), note({ secret: "1", value: 0n })];
  assert.ok(isBalanced(dummies, [note({ value: 100n }), note({ value: 0n })], 100n, 0n));
  // Minting from nothing must not balance.
  assert.ok(!isBalanced(i, [note({ value: 101n }), note({ value: 0n })], 0n, 0n));
});

test("leafIndexFromPathIndices reads the position bits LSB first", () => {
  assert.equal(leafIndexFromPathIndices([0, 0, 0]), 0);
  assert.equal(leafIndexFromPathIndices([1, 0, 0]), 1);
  assert.equal(leafIndexFromPathIndices([0, 1, 0]), 2);
  assert.equal(leafIndexFromPathIndices([1, 1, 0]), 3);
  assert.equal(leafIndexFromPathIndices([1, 0, 1]), 5);
});
