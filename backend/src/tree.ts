// Sparse incremental Poseidon-Merkle tree, depth 20. Mirrors the on-chain tree
// the claim circuit proves membership against. Rebuilt from persisted leaves at
// startup; no separate tree file needed.

import { poseidon } from "./poseidon.js";
import * as leaves from "./leaves.js";

export const DEPTH = 20;

// zeroHashes[i] = hash of an empty subtree at level i.
// zeroHashes[0] = 0; zeroHashes[i+1] = Poseidon(zeroHashes[i], zeroHashes[i]).
export const zeroHashes: string[] = (() => {
  const zs: string[] = ["0"];
  for (let i = 0; i < DEPTH; i++) zs.push(poseidon([zs[i], zs[i]]));
  return zs;
})();

// nodes.get(`${level},${index}`) = filled hash at that position.
// Missing entries are implicitly zeroHashes[level].
const nodes = new Map<string, string>();

function key(level: number, index: number): string {
  return `${level},${index}`;
}

function getNode(level: number, index: number): string {
  return nodes.get(key(level, index)) ?? zeroHashes[level];
}

/** Insert a leaf at the given index and recompute the path up to the root. */
function insertAt(leaf: string, leafIndex: number): void {
  nodes.set(key(0, leafIndex), leaf);
  let idx = leafIndex;
  for (let level = 0; level < DEPTH; level++) {
    const parentIdx = idx >> 1;
    const isRight = idx & 1;
    const left = isRight ? getNode(level, idx - 1) : getNode(level, idx);
    const right = isRight ? getNode(level, idx) : getNode(level, idx + 1);
    nodes.set(key(level + 1, parentIdx), poseidon([left, right]));
    idx = parentIdx;
  }
}

/** Rebuild the in-memory tree from persisted leaves. */
export function rebuild(): void {
  nodes.clear();
  const all = leaves.list();
  for (let i = 0; i < all.length; i++) insertAt(all[i], i);
}

/** Current Merkle root (as decimal string). */
export function root(): string {
  return getNode(DEPTH, 0);
}

export interface Path {
  pathElements: string[]; // length DEPTH
  pathIndices: number[];  // length DEPTH; 0 = my node is on the left
  root: string;
}

/** Merkle path for the leaf at `leafIndex` against the CURRENT tree state. */
export function pathFor(leafIndex: number): Path {
  if (leafIndex < 0 || leafIndex >= leaves.count()) {
    throw new Error(`leafIndex ${leafIndex} out of range (have ${leaves.count()} leaves)`);
  }
  const pathElements: string[] = [];
  const pathIndices: number[] = [];
  let idx = leafIndex;
  for (let level = 0; level < DEPTH; level++) {
    const isRight = idx & 1;
    pathIndices.push(isRight);
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    pathElements.push(getNode(level, siblingIdx));
    idx = idx >> 1;
  }
  return { pathElements, pathIndices, root: root() };
}

/** Called after leaves.insert() to keep the tree in sync. */
export function onLeafInserted(leaf: string, leafIndex: number): void {
  insertAt(leaf, leafIndex);
}

// Initial build from persisted state.
rebuild();
