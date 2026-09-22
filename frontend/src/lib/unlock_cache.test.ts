import assert from "node:assert/strict";
import test from "node:test";

import {
  clearUnlock,
  loadUnlock,
  saveUnlock,
  touchUnlock,
  UNLOCK_TTL_MS,
} from "./unlock_cache";

// Minimal Storage stand-ins. The cache helpers only touch them when called,
// so installing them after the import is fine. Both globals are stubbed, with
// separate backings, so a test can tell which one the cache actually writes
// to: sessionStorage is per-tab, and the unlock is meant to be shared.
function fakeStorage(store: Map<string, string>) {
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
}

const store = new Map<string, string>();
const perTabStore = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = fakeStorage(store);
(globalThis as { sessionStorage?: unknown }).sessionStorage =
  fakeStorage(perTabStore);

const STORAGE_KEY = "bullet.unlock";
const KEYS = {
  pubKeyHex: "aa".repeat(32),
  curveSecret: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
};

function storedExpiry(): number {
  return JSON.parse(store.get(STORAGE_KEY)!).expiresAt;
}

function setExpiry(at: number) {
  const u = JSON.parse(store.get(STORAGE_KEY)!);
  u.expiresAt = at;
  store.set(STORAGE_KEY, JSON.stringify(u));
}

test("a saved unlock round-trips the viewing key", () => {
  clearUnlock();
  saveUnlock("GABC", KEYS);
  const got = loadUnlock();
  assert.equal(got?.address, "GABC");
  assert.equal(got?.keys.pubKeyHex, KEYS.pubKeyHex);
  // The secret is what opens sealed notes: a truncated or re-encoded copy
  // decrypts nothing, so compare it byte for byte.
  assert.deepEqual(got?.keys.curveSecret, KEYS.curveSecret);
});

test("an unlock older than the idle window is refused and wiped", () => {
  clearUnlock();
  saveUnlock("GABC", KEYS);
  setExpiry(Date.now() - 1);
  assert.equal(loadUnlock(), null);
  assert.equal(store.has(STORAGE_KEY), false, "expired key must not linger");
});

test("activity extends the deadline, expiry is not revivable", () => {
  clearUnlock();
  saveUnlock("GABC", KEYS);
  setExpiry(Date.now() + 1_000);
  touchUnlock();
  assert.ok(
    storedExpiry() > Date.now() + UNLOCK_TTL_MS - 5_000,
    "touch should push the deadline a full TTL out"
  );

  setExpiry(Date.now() - 1);
  touchUnlock();
  assert.equal(loadUnlock(), null, "touch must not resurrect an expired unlock");
});

// A second tab is a second module instance over the same backing store, so
// what makes the unlock shared is the storage it lands in, nothing else.
test("the unlock is shared across tabs, not scoped to one", () => {
  clearUnlock();
  perTabStore.clear();
  saveUnlock("GABC", KEYS);
  assert.ok(store.has(STORAGE_KEY), "unlock must live in localStorage");
  assert.equal(
    perTabStore.has(STORAGE_KEY),
    false,
    "sessionStorage would scope the unlock to a single tab"
  );

  // Sign-out in one tab has to revoke it for every tab.
  clearUnlock();
  assert.equal(loadUnlock(), null);
  assert.equal(store.has(STORAGE_KEY), false);
});

test("corrupt storage fails closed", () => {
  store.set(STORAGE_KEY, "{not json");
  assert.equal(loadUnlock(), null);
  assert.equal(store.has(STORAGE_KEY), false);
});
