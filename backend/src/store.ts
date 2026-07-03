// User-centric account store.
//
// One User can have many Identities (Google, Twitter, ...) and at most one
// Wallet (Stellar address + Bullet pubkey). Persisted as a single JSON file;
// two derived indexes (subject → user, lookup-key → user) live in memory only.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(fileURLToPath(import.meta.url), "../../data");
const USERS_FILE =
  process.env.USERS_FILE_OVERRIDE ?? path.join(DATA_DIR, "users.json");

export type Provider = "twitter" | "google";

export interface Identity {
  provider: Provider;
  subject: string;     // provider's stable user ID
  handle: string;      // "@alice" for twitter, email for google
  email?: string;
  linkedAt: string;
}

export interface Wallet {
  stellarAddress: string;
  zeekPayPubKey: string;
  signature: string;   // Ed25519 over `bullet-link-wallet-v1:{userId}`
  attachedAt: string;
}

export interface User {
  id: string;
  createdAt: string;
  identities: Identity[];
  wallet: Wallet | null;
}

const users = new Map<string, User>();
const subjectIndex = new Map<string, string>();  // `${provider}:${subject}` → userId
const lookupIndex = new Map<string, string>();   // normalized key → userId

function subjectKey(provider: Provider, subject: string): string {
  return `${provider}:${subject}`;
}

/** Normalize a handle/email to a lookup key. */
export function normalizeKey(q: string): string {
  const t = q.trim();
  return t.startsWith("@") ? "@" + t.slice(1).toLowerCase() : t.toLowerCase();
}

function indexIdentity(userId: string, ident: Identity): void {
  subjectIndex.set(subjectKey(ident.provider, ident.subject), userId);
  lookupIndex.set(normalizeKey(ident.handle), userId);
  if (ident.email) lookupIndex.set(normalizeKey(ident.email), userId);
}

function load(): void {
  if (!fs.existsSync(USERS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) as Record<string, User>;
    for (const [id, u] of Object.entries(raw)) {
      users.set(id, u);
      u.identities.forEach((i) => indexIdentity(id, i));
    }
  } catch {
    // Corrupted file — start fresh, do not crash the server.
  }
}

function persist(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const obj: Record<string, User> = {};
  for (const [k, v] of users) obj[k] = v;
  fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2));
}

// ── read API ─────────────────────────────────────────────────────────────────

export function getUser(userId: string): User | null {
  return users.get(userId) ?? null;
}

export function findByProviderSubject(
  provider: Provider,
  subject: string
): User | null {
  const id = subjectIndex.get(subjectKey(provider, subject));
  return id ? users.get(id) ?? null : null;
}

/** Public lookup used by /resolve. Matches any linked handle or email. */
export function findByLookup(query: string): User | null {
  const id = lookupIndex.get(normalizeKey(query));
  return id ? users.get(id) ?? null : null;
}

// ── write API ────────────────────────────────────────────────────────────────

export type WriteResult<T = { user: User }> =
  | ({ ok: true } & T)
  | { conflict: true; detail: string };

/** Create a new user with an initial identity. */
export function createUserWithIdentity(
  ident: Omit<Identity, "linkedAt">
): WriteResult {
  if (subjectIndex.has(subjectKey(ident.provider, ident.subject))) {
    return { conflict: true, detail: "identity already registered to another user" };
  }
  if (lookupIndex.has(normalizeKey(ident.handle))) {
    return { conflict: true, detail: `handle ${ident.handle} already taken` };
  }
  if (ident.email && lookupIndex.has(normalizeKey(ident.email))) {
    return { conflict: true, detail: `email ${ident.email} already taken` };
  }
  const id = "usr_" + crypto.randomBytes(8).toString("hex");
  const full: Identity = { ...ident, linkedAt: new Date().toISOString() };
  const user: User = {
    id,
    createdAt: full.linkedAt,
    identities: [full],
    wallet: null,
  };
  users.set(id, user);
  indexIdentity(id, full);
  persist();
  return { ok: true, user };
}

/** Attach an additional identity to an existing user. */
export function addIdentity(
  userId: string,
  ident: Omit<Identity, "linkedAt">
): WriteResult {
  const user = users.get(userId);
  if (!user) return { conflict: true, detail: "user not found" };
  const existingSubject = subjectIndex.get(subjectKey(ident.provider, ident.subject));
  if (existingSubject && existingSubject !== userId) {
    return { conflict: true, detail: "identity already registered to another user" };
  }
  if (existingSubject === userId) return { ok: true, user };  // idempotent
  const dupHandle = lookupIndex.get(normalizeKey(ident.handle));
  if (dupHandle && dupHandle !== userId) {
    return { conflict: true, detail: `handle ${ident.handle} already taken` };
  }
  if (ident.email) {
    const dupEmail = lookupIndex.get(normalizeKey(ident.email));
    if (dupEmail && dupEmail !== userId) {
      return { conflict: true, detail: `email ${ident.email} already taken` };
    }
  }
  const full: Identity = { ...ident, linkedAt: new Date().toISOString() };
  user.identities.push(full);
  indexIdentity(userId, full);
  persist();
  return { ok: true, user };
}

/** Attach a wallet to a user. Rejects if a different wallet is already attached. */
export function attachWallet(userId: string, wallet: Omit<Wallet, "attachedAt">): WriteResult {
  const user = users.get(userId);
  if (!user) return { conflict: true, detail: "user not found" };
  if (user.wallet && user.wallet.stellarAddress !== wallet.stellarAddress) {
    return { conflict: true, detail: "different wallet already attached" };
  }
  user.wallet = { ...wallet, attachedAt: new Date().toISOString() };
  persist();
  return { ok: true, user };
}

// test-only: wipe all state.
export function _resetForTests(): void {
  users.clear();
  subjectIndex.clear();
  lookupIndex.clear();
  fs.rmSync(USERS_FILE, { force: true });
}

load();
