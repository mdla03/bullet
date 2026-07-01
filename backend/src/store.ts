import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(fileURLToPath(import.meta.url), "../../data");
const REGISTRY_FILE =
  process.env.REGISTRY_FILE_OVERRIDE ??
  path.join(DATA_DIR, "registry.json");

export interface Entry {
  handle?: string;
  email?: string;
  stellarAddress: string;
  zeekPayPubKey: string;
  signature: string;
  registeredAt: string;
}

// Normalized key (e.g. "@alice" or "user@example.com") → entry
const registry = new Map<string, Entry>();

function load(): void {
  if (!fs.existsSync(REGISTRY_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<
      string,
      Entry
    >;
    for (const [k, v] of Object.entries(raw)) registry.set(k, v);
  } catch {
    // Corrupted file — start fresh; do not crash the server.
  }
}

function persist(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const obj: Record<string, Entry> = {};
  for (const [k, v] of registry) obj[k] = v;
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(obj, null, 2));
}

/** Normalize a raw query string to a lookup key. */
export function normalizeKey(q: string): string {
  const trimmed = q.trim();
  if (trimmed.startsWith("@")) {
    return "@" + trimmed.slice(1).toLowerCase();
  }
  return trimmed.toLowerCase();
}

export function lookup(key: string): Entry | undefined {
  return registry.get(key);
}

export type RegisterResult =
  | { ok: true }
  | { conflict: true; detail: string };

export function register(entry: Omit<Entry, "registeredAt">): RegisterResult {
  const keys: string[] = [];
  if (entry.handle) keys.push(normalizeKey(entry.handle));
  if (entry.email) keys.push(normalizeKey(entry.email));

  // Conflict check: any existing key pointing to a different Stellar address.
  for (const k of keys) {
    const existing = registry.get(k);
    if (existing && existing.stellarAddress !== entry.stellarAddress) {
      return {
        conflict: true,
        detail: `${k} is already registered to a different address`,
      };
    }
  }

  const full: Entry = { ...entry, registeredAt: new Date().toISOString() };
  for (const k of keys) registry.set(k, full);
  persist();
  return { ok: true };
}

// Load on module init.
load();
