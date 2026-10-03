import { test } from "node:test";
import { strict as assert } from "node:assert";
import { deserializeNote, serializeNote, type StoredNote } from "./pool_wallet";

const entry = (over: Partial<StoredNote> = {}): StoredNote => ({
  note: { secret: "123", recipientDigest: "42", value: 77_777_777n, tokenId: 1, leafIndex: 9 },
  status: "ready",
  fundedTx: "abc",
  createdAt: "2026-10-03T00:00:00Z",
  ...over,
});

test("serialize round-trips, and value survives as bigint", () => {
  const s = entry();
  const back = deserializeNote(serializeNote(s));
  assert.equal(typeof back.note.value, "bigint");
  assert.deepEqual(back.note, s.note);
  assert.equal(back.status, s.status);
  assert.equal(back.fundedTx, s.fundedTx);
  assert.equal(back.createdAt, s.createdAt);
});

test("a large value does not lose precision through JSON", () => {
  // 18 quintillion stroops exceeds Number.MAX_SAFE_INTEGER; a naive number
  // field would round it. The string path must preserve it exactly.
  const big = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
  const back = deserializeNote(serializeNote(entry({ note: { secret: "1", recipientDigest: "2", value: big, tokenId: 0 } })));
  assert.equal(back.note.value, big);
});

test("optional leafIndex absent stays absent", () => {
  const s = entry({ note: { secret: "1", recipientDigest: "2", value: 5n, tokenId: 1 } });
  const j = serializeNote(s);
  assert.equal(j.leafIndex, undefined);
  assert.equal(deserializeNote(j).note.leafIndex, undefined);
});
