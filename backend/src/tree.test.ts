// Verifies the sparse Merkle tree matches the on-chain circuit's expectations.
// Run: node --import tsx/esm --test src/tree.test.ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { poseidon } from "./poseidon.js";

// Point the leaves store at a per-run temp file BEFORE importing tree.
const TMP = path.join(os.tmpdir(), `zk_tree_test_${Date.now()}.json`);
process.env.LEAVES_FILE_OVERRIDE = TMP;
fs.rmSync(TMP, { force: true });

const leaves = await import("./leaves.js");
const tree = await import("./tree.js");

beforeEach(() => {
  leaves._resetForTests();
  tree.rebuild();
});

describe("SparseMerkleTree(depth=20) over BLS12-381 Poseidon", () => {
  it("empty tree root equals zeroHashes[DEPTH]", () => {
    assert.equal(tree.root(), tree.zeroHashes[tree.DEPTH]);
  });

  it("inserting leaf Poseidon(12345,42,10) at index 0 gives the known root", () => {
    // Matches circuits/build/claim_input.json.
    const commitment = poseidon(["12345", "42", "10"]);
    const idx = leaves.insert(commitment);
    tree.onLeafInserted(commitment, idx);
    assert.equal(
      tree.root(),
      "19148948013232879213203992136026734822699351263916619827234416357547906460635"
    );
  });

  it("pathFor(0) with 2 leaves: sibling at level 0 IS the other leaf", () => {
    const c0 = poseidon(["1", "1", "1"]);
    const c1 = poseidon(["2", "2", "10"]);
    tree.onLeafInserted(c0, leaves.insert(c0));
    tree.onLeafInserted(c1, leaves.insert(c1));

    const p = tree.pathFor(0);
    assert.equal(p.pathElements[0], c1, "leaf 0's level-0 sibling should be leaf 1");
    assert.equal(p.pathIndices[0], 0, "leaf 0 is on the left at level 0");
    // Hashing up the returned path must reproduce the returned root.
    let cur = c0;
    for (let i = 0; i < 20; i++) {
      const [l, r] = p.pathIndices[i] ? [p.pathElements[i], cur] : [cur, p.pathElements[i]];
      cur = poseidon([l, r]);
    }
    assert.equal(cur, p.root, "path must hash up to the reported root");
  });

  it("rebuild() from persisted leaves reconstructs the same root", () => {
    const cs = ["10", "20", "30"].map((s) => poseidon([s, "42", "10"]));
    cs.forEach((c) => tree.onLeafInserted(c, leaves.insert(c)));
    const rootAfter = tree.root();
    tree.rebuild();
    assert.equal(tree.root(), rootAfter, "rebuild should be deterministic");
  });

  // ── the anonymity-set property (why we bothered with any of this) ──────────
  function hashUp(leaf: string, p: { pathElements: string[]; pathIndices: number[] }) {
    let cur = leaf;
    for (let i = 0; i < 20; i++) {
      const [l, r] = p.pathIndices[i] ? [p.pathElements[i], cur] : [cur, p.pathElements[i]];
      cur = poseidon([l, r]);
    }
    return cur;
  }

  it("every leaf in a multi-leaf tree hashes up to the SAME shared root", () => {
    // 5 deposits from 5 different senders sharing one tree.
    const cs = ["100", "200", "300", "400", "500"].map((s) => poseidon([s, "42", "10"]));
    cs.forEach((c) => tree.onLeafInserted(c, leaves.insert(c)));
    const sharedRoot = tree.root();

    for (let i = 0; i < cs.length; i++) {
      const p = tree.pathFor(i);
      assert.equal(p.root, sharedRoot, `pathFor(${i}) reports the shared root`);
      assert.equal(hashUp(cs[i], p), sharedRoot, `leaf ${i} hashes up to shared root`);
    }
  });

  it("later inserts change earlier leaves' paths — must reprove against current root", () => {
    const c0 = poseidon(["1", "42", "10"]);
    tree.onLeafInserted(c0, leaves.insert(c0));
    const before = tree.pathFor(0);
    const rootBefore = tree.root();

    // A later, unrelated deposit lands.
    const c1 = poseidon(["999", "77", "50"]);
    tree.onLeafInserted(c1, leaves.insert(c1));
    const after = tree.pathFor(0);

    // Leaf 0's level-0 sibling flipped from zero to c1.
    assert.notEqual(before.pathElements[0], after.pathElements[0]);
    assert.equal(after.pathElements[0], c1);
    // Root moved; old proof would fail on-chain against the new root.
    assert.notEqual(rootBefore, tree.root());
    // But leaf 0 still hashes up to the CURRENT root via the NEW path.
    assert.equal(hashUp(c0, after), tree.root());
  });
});
