import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(fileURLToPath(import.meta.url), "../../data");
const LEAVES_FILE =
  process.env.LEAVES_FILE_OVERRIDE ?? path.join(DATA_DIR, "leaves.json");

// Commitments (decimal strings, Fr < BLS12-381 r) keyed by position: slot i
// holds the leaf at the contract's leafIndex i. A hole is a leaf we have not
// seen yet; see missing().
let leaves: string[] = [];

function load(): void {
  if (!fs.existsSync(LEAVES_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(LEAVES_FILE, "utf8"));
    if (Array.isArray(raw))
      raw.forEach((c, i) => {
        if (c != null) leaves[i] = String(c);
      });
  } catch {
    // Corrupted file — start fresh; do not crash the server.
  }
}

function persist(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEAVES_FILE, JSON.stringify(leaves, null, 2));
}

/** Append a commitment; if it already exists, return its existing index (idempotent). */
export function insert(commitment: string): number {
  const existing = leaves.indexOf(commitment);
  if (existing !== -1) return existing;
  leaves.push(commitment);
  persist();
  return leaves.length - 1;
}

/** Place a commitment at the contract's leafIndex (overwrites that slot).
 *  Does not persist to disk by itself: call flush() once after a batch of
 *  setAt calls, or pass { persist: true } to write through immediately. */
export function setAt(
  leafIndex: number,
  commitment: string,
  opts?: { persist?: boolean }
): void {
  leaves[leafIndex] = commitment;
  if (opts?.persist) persist();
}

/** Write the current in-memory leaf list to disk. Call after one or more
 *  setAt calls made without { persist: true }. */
export function flush(): void {
  persist();
}

export function at(leafIndex: number): string | undefined {
  return leaves[leafIndex];
}

/** Indices below count() that have no leaf. Any entry means the tree is wrong. */
export function missing(): number[] {
  const out: number[] = [];
  for (let i = 0; i < leaves.length; i++) if (leaves[i] === undefined) out.push(i);
  return out;
}

/** Snapshot the current leaf list (returned by value; holes stay holes). */
export function list(): string[] {
  return leaves.slice();
}

export function indexOf(commitment: string): number {
  return leaves.indexOf(commitment);
}

/** One past the highest occupied index (holes included). */
export function count(): number {
  return leaves.length;
}

/** Reset the in-memory + on-disk list. Used when re-hydrating from the durable
 *  Postgres store (the source of truth) so memory exactly matches the DB. */
export function clearAll(): void {
  leaves = [];
  persist();
}

// test-only: wipe in-memory + persisted state.
export function _resetForTests(): void {
  leaves = [];
  fs.rmSync(LEAVES_FILE, { force: true });
}

load();
