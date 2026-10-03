import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HANDLE_TYPES, mapMetrics, type RawMetrics } from "./dashboard_metrics";

const RAW: RawMetrics = {
  deposits: 7,
  cursor_ledger: 4983770,
  users: 12,
  unclaimed_notes: 3,
  pending_invites: 1,
  transactions: 40,
  sends: 25,
  claims: 15,
  active_accounts: 9,
  volume: { "1": 5_000_000, "0": 120_000_000 },
  daily: [{ date: "2026-10-01", sends: 2, claims: 1 }],
  dau: 2,
  mau: 8,
  wallets_attached: 10,
  wallets_unique: 14,
  handles: { google: 3, email: 2, twitter_v2: 4, nope: 99 },
  sends_by_handle: {
    "alice@example.com": 2,
    "@bob": 3,
    "github:carol": 1,
    "bogus handle": 5,
  },
  recent: [],
};

test("counts stay what Postgres reported", () => {
  const m = mapMetrics(RAW);
  assert.equal(m.transactions, 40);
  assert.equal(m.sends, 25);
  assert.equal(m.claims, 15);
  assert.equal(m.activeAccounts, 9);
  assert.equal(m.walletsConnected, 14);
  assert.equal(m.walletsAttached, 10);
  assert.equal(m.dau, 2);
  assert.equal(m.mau, 8);
});

test("volume converts stroops to whole units, lowest token id first", () => {
  assert.deepEqual(mapMetrics(RAW).volume, [
    [0, 12],
    [1, 0.5],
  ]);
});

test("email links and sends fold into Google, unknown providers are dropped", () => {
  const m = mapMetrics(RAW);
  // 3 google + 2 email, and the unregistered "nope" provider contributes
  // nothing rather than inventing a row.
  assert.equal(m.linkedHandles.get("google"), 5);
  assert.equal(m.linkedHandles.get("x"), 4);
  // A bare address is Google's canonical form too, so its sends land there.
  assert.equal(m.sendsByType.get("google"), 2);
  assert.equal(m.sendsByType.get("x"), 3);
  assert.equal(m.sendsByType.get("github"), 1);
});

test("sends to a handle the registry no longer owns are counted, not lost", () => {
  // Counts the sends, not the distinct handles: the group arrives pre-counted.
  assert.equal(mapMetrics(RAW).sendsUnknownType, 5);
});

test("every enabled platform gets a row, including the ones at zero", () => {
  const m = mapMetrics({ ...RAW, handles: {}, sends_by_handle: {} });
  for (const t of HANDLE_TYPES) {
    assert.equal(m.linkedHandles.get(t.id), 0, t.id);
    assert.equal(m.sendsByType.get(t.id), 0, t.id);
  }
  assert.equal(m.sendsUnknownType, 0);
});
