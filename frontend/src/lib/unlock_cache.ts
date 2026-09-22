// Inbox unlock cache.
//
// The viewing key derived from the Freighter signature is kept in
// localStorage, so a reload or a second tab inside the idle window doesn't
// need another signature prompt. localStorage outlives the tab and the browser
// session, which makes the UNLOCK_TTL_MS deadline the only thing bounding it:
// every read goes through read(), which wipes an expired entry rather than
// returning it. This is the read key only: claiming still needs a wallet
// signature on the transaction, so a stale cache can open notes but cannot
// move money.

import type { BulletKeys } from "./notes";

const STORAGE_KEY = "bullet.unlock";
export const UNLOCK_TTL_MS = 5 * 60 * 1000;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface StoredUnlock {
  address: string;
  pubKeyHex: string;
  curveSecretHex: string;
  expiresAt: number;
}

function read(): StoredUnlock | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as StoredUnlock;
    if (!u.curveSecretHex || Date.now() > u.expiresAt) {
      clearUnlock();
      return null;
    }
    return u;
  } catch {
    clearUnlock();
    return null;
  }
}

export function saveUnlock(address: string, keys: BulletKeys): void {
  if (typeof localStorage === "undefined") return;
  const u: StoredUnlock = {
    address,
    pubKeyHex: keys.pubKeyHex,
    curveSecretHex: bytesToHex(keys.curveSecret),
    expiresAt: Date.now() + UNLOCK_TTL_MS,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
}

/** Cached unlock, or null once it has expired. */
export function loadUnlock(): { address: string; keys: BulletKeys } | null {
  const u = read();
  if (!u) return null;
  return {
    address: u.address,
    keys: { pubKeyHex: u.pubKeyHex, curveSecret: hexToBytes(u.curveSecretHex) },
  };
}

/** Push the idle deadline out. No-op if nothing is cached, or it has expired. */
export function touchUnlock(): void {
  const u = read();
  if (!u) return;
  u.expiresAt = Date.now() + UNLOCK_TTL_MS;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
}

export function clearUnlock(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}
