import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(fileURLToPath(import.meta.url), "../../data");
const LEAVES_FILE =
  process.env.LEAVES_FILE_OVERRIDE ?? path.join(DATA_DIR, "leaves.json");

// Append-only list of commitments (decimal strings, Fr < BLS12-381 r).
// Position in the list = leafIndex in the Merkle tree.
let leaves: string[] = [];

function load(): void {
  if (!fs.existsSync(LEAVES_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(LEAVES_FILE, "utf8"));
    if (Array.isArray(raw)) leaves = raw.map(String);
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

/** Snapshot the current leaf list (returned by value). */
export function list(): string[] {
  return leaves.slice();
}

export function indexOf(commitment: string): number {
  return leaves.indexOf(commitment);
}

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
