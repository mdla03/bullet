// Wallet-switch history rules. The money question: after a switch, does the
// old Bullet key stay reachable? Notes addressed to it can ONLY be claimed by
// reconnecting that wallet, so losing the entry loses the notes.
// Run: node --import tsx/esm --test src/wallet_history.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// store.ts pulls in the Supabase client at import time, which refuses to load
// without config. These placeholders are never dialled: the functions under
// test are pure.
process.env.SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder";

const { allPubkeys, nextPrevious } = await import("./store.js");

const A = { stellar_address: "GA…A", bullet_pubkey: "aa" };
const B = { stellar_address: "GB…B", bullet_pubkey: "bb" };
const NOW = "2026-08-13T00:00:00.000Z";

describe("nextPrevious", () => {
  it("has no history for a first link", () => {
    assert.deepEqual(nextPrevious(null, A.bullet_pubkey, NOW), []);
  });

  it("keeps the outgoing wallet when switching", () => {
    assert.deepEqual(nextPrevious({ ...A, previous: [] }, B.bullet_pubkey, NOW), [
      { ...A, unlinked_at: NOW },
    ]);
  });

  it("is a no-op when re-linking the same wallet", () => {
    const previous = [{ ...B, unlinked_at: NOW }];
    assert.deepEqual(nextPrevious({ ...A, previous }, A.bullet_pubkey, NOW), previous);
  });

  it("accumulates across repeated switches", () => {
    const afterFirst = nextPrevious({ ...A, previous: [] }, B.bullet_pubkey, NOW);
    const afterSecond = nextPrevious({ ...B, previous: afterFirst }, "cc", NOW);
    assert.deepEqual(afterSecond.map((p) => p.bullet_pubkey), ["aa", "bb"]);
  });

  it("tolerates a null previous column (row written before the migration)", () => {
    assert.deepEqual(nextPrevious({ ...A, previous: null }, B.bullet_pubkey, NOW), [
      { ...A, unlinked_at: NOW },
    ]);
  });
});

describe("allPubkeys", () => {
  it("lists current first, then history", () => {
    assert.deepEqual(
      allPubkeys({ bullet_pubkey: "bb", previous: [{ ...A, unlinked_at: NOW }] }),
      ["bb", "aa"]
    );
  });

  it("dedupes when the user switched back to an earlier wallet", () => {
    assert.deepEqual(
      allPubkeys({
        bullet_pubkey: "aa",
        previous: [
          { ...A, unlinked_at: NOW },
          { ...B, unlinked_at: NOW },
        ],
      }),
      ["aa", "bb"]
    );
  });

  it("handles a wallet with no history", () => {
    assert.deepEqual(allPubkeys({ bullet_pubkey: "aa" }), ["aa"]);
  });
});
