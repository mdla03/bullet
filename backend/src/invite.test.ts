// Invite claim-marking + list-filtering tests.
//
// Covers the "already claimed via claim link but still shows as a sent
// invite" bug: markNoteClaimedIfOwned (store.ts) must propagate claimed_at
// from the notes row to the linked pending_invites row (via notes.invite_id),
// and listInvitesForSender (invite.ts) must exclude claimed rows.
//
// store.ts and invite.ts both import the real serviceClient from
// ./supabase.js, which needs live Supabase creds to construct. We mock
// ./supabase.js with an in-memory fake query builder (same
// --experimental-test-module-mocks technique resolver.test.ts uses for
// store.js) so these run offline and deterministically.
// Run: node --import tsx/esm --experimental-test-module-mocks --test src/invite.test.ts
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "placeholder_anon_key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder_service_role_key";

type Row = Record<string, unknown>;

/** Minimal in-memory stand-in for the slice of the supabase-js query builder
 * that store.ts / invite.ts actually use: select/update, eq/in/is filters,
 * order (no-op, tables are pre-sorted or order doesn't matter for these
 * tests), and a maybeSingle terminal. Every builder call is also directly
 * awaitable (a `.then`), matching how invite.ts awaits selects and the
 * batched update without a `.maybeSingle()` at the end. No insert/single: the
 * functions under test never call them (recordInvite/insertNote/insertActivity
 * use insert, but aren't exercised here). */
function makeFakeSupabase(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rows = tables[table];
    if (!rows) throw new Error(`fake supabase: unknown table "${table}"`);
    let mode: "select" | "update" = "select";
    let payload: Row | null = null;
    const filters: ((r: Row) => boolean)[] = [];

    function matched(): Row[] {
      return rows.filter((r) => filters.every((f) => f(r)));
    }

    async function run(): Promise<{ data: Row[] | null; error: { message: string } | null }> {
      if (mode === "update") {
        const rowsMatched = matched();
        rowsMatched.forEach((r) => Object.assign(r, payload));
        return { data: rowsMatched, error: null };
      }
      return { data: matched(), error: null };
    }

    const builder = {
      select() {
        return builder;
      },
      update(data: Row) {
        mode = "update";
        payload = data;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      is(col: string, val: null) {
        filters.push((r) => (r[col] ?? null) === val);
        return builder;
      },
      order() {
        return builder;
      },
      async maybeSingle() {
        const { data, error } = await run();
        return { data: data?.[0] ?? null, error };
      },
      then(
        onFulfilled: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
        onRejected?: (e: unknown) => unknown
      ) {
        return run().then(onFulfilled, onRejected);
      },
    };
    return builder;
  }
  return { from };
}

// Mutated in place (never reassigned) so the single serviceClient instance
// created below — which mock.module's namedExports resolves once, not on
// every access — keeps seeing each test's reset data.
const tables: { wallets: Row[]; notes: Row[]; pending_invites: Row[] } = {
  wallets: [],
  notes: [],
  pending_invites: [],
};

function resetTables() {
  tables.wallets.length = 0;
  tables.wallets.push({ user_id: "usr_recipient", bullet_pubkey: "pub_recipient", previous: [] });

  tables.notes.length = 0;
  tables.notes.push(
    // A note delivered from an invite: invite_id links it to pending_invites.
    { id: "note_invite", recipient_pubkey: "pub_recipient", invite_id: "inv_1", claimed_at: null },
    // A note from a normal (non-invite) send: no invite_id.
    { id: "note_plain", recipient_pubkey: "pub_recipient", invite_id: null, claimed_at: null }
  );

  tables.pending_invites.length = 0;
  tables.pending_invites.push(
    {
      id: "inv_1",
      sender_user_id: "usr_sender",
      handle_normalized: "recipient@example.com",
      denom: 100_000_000,
      expires_at: "2026-12-01T00:00:00.000Z",
      delivered_at: "2026-09-20T00:00:00.000Z",
      claimed_at: null,
      refunded_at: null,
      created_at: "2026-09-19T00:00:00.000Z",
    },
    {
      id: "inv_2",
      sender_user_id: "usr_sender",
      handle_normalized: "other@example.com",
      denom: 50_000_000,
      expires_at: "2026-12-01T00:00:00.000Z",
      delivered_at: null,
      claimed_at: null,
      refunded_at: null,
      created_at: "2026-09-18T00:00:00.000Z",
    }
  );
}
resetTables();

mock.module("./supabase.js", {
  namedExports: {
    serviceClient: makeFakeSupabase(tables as unknown as Record<string, Row[]>),
  },
});

const { markNoteClaimedIfOwned, markInviteClaimedIfOwned } = await import("./store.js");
const { listInvitesForSender, nullifierHexFromSecret } = await import("./invite.js");

beforeEach(() => {
  resetTables();
});

describe("markNoteClaimedIfOwned", () => {
  it("marks the linked pending_invites row claimed when an invite note is claimed", async () => {
    const ok = await markNoteClaimedIfOwned("usr_recipient", "note_invite");
    assert.equal(ok, true);
    const invite = tables.pending_invites.find((r) => r.id === "inv_1")!;
    assert.notEqual(invite.claimed_at, null, "pending_invites.claimed_at should be stamped");
  });

  it("does not touch pending_invites for a plain (non-invite) note", async () => {
    const ok = await markNoteClaimedIfOwned("usr_recipient", "note_plain");
    assert.equal(ok, true);
    // Nothing in pending_invites should have changed.
    assert.equal(tables.pending_invites.find((r) => r.id === "inv_1")!.claimed_at, null);
    assert.equal(tables.pending_invites.find((r) => r.id === "inv_2")!.claimed_at, null);
  });

  it("returns false and marks nothing when the note isn't owned by the caller's wallet", async () => {
    const ok = await markNoteClaimedIfOwned("usr_someone_else", "note_invite");
    assert.equal(ok, false);
    assert.equal(tables.notes.find((r) => r.id === "note_invite")!.claimed_at, null);
    assert.equal(tables.pending_invites.find((r) => r.id === "inv_1")!.claimed_at, null);
  });

  it("persists the claim tx hash on the notes row when given", async () => {
    const ok = await markNoteClaimedIfOwned("usr_recipient", "note_plain", "tx_abc123");
    assert.equal(ok, true);
    assert.equal(tables.notes.find((r) => r.id === "note_plain")!.claim_tx, "tx_abc123");
  });

  it("leaves claim_tx unset when no tx hash is given", async () => {
    const ok = await markNoteClaimedIfOwned("usr_recipient", "note_plain");
    assert.equal(ok, true);
    assert.equal(tables.notes.find((r) => r.id === "note_plain")!.claim_tx, undefined);
  });
});

describe("markInviteClaimedIfOwned", () => {
  it("marks pending_invites claimed when a notes row proves delivery to the caller, without touching the notes row itself", async () => {
    const ok = await markInviteClaimedIfOwned("usr_recipient", "inv_1");
    assert.equal(ok, true);
    assert.notEqual(
      tables.pending_invites.find((r) => r.id === "inv_1")!.claimed_at,
      null
    );
    // This path doesn't go through notes.claimed_at at all.
    assert.equal(tables.notes.find((r) => r.id === "note_invite")!.claimed_at, null);
  });

  // Both cases must leave pending_invites untouched, just for different
  // reasons: no delivery record at all vs. a delivery record for someone else.
  for (const c of [
    {
      label: "no notes row links this invite to the caller's wallet",
      userId: "usr_recipient",
      inviteId: "inv_2", // never delivered: no note in the fixture
    },
    {
      label: "the caller's wallet doesn't own the linked note",
      userId: "usr_someone_else",
      inviteId: "inv_1",
    },
  ]) {
    it(`returns false when ${c.label}`, async () => {
      const ok = await markInviteClaimedIfOwned(c.userId, c.inviteId);
      assert.equal(ok, false);
      assert.equal(tables.pending_invites.find((r) => r.id === c.inviteId)!.claimed_at, null);
    });
  }

  it("is idempotent: a second call is a no-op that still returns false", async () => {
    const first = await markInviteClaimedIfOwned("usr_recipient", "inv_1");
    const second = await markInviteClaimedIfOwned("usr_recipient", "inv_1");
    assert.equal(first, true);
    assert.equal(second, false);
  });
});

describe("listInvitesForSender", () => {
  it("excludes a claimed invite from the sender's list", async () => {
    // Simulate the claim: mark inv_1's note claimed, which should cascade.
    await markNoteClaimedIfOwned("usr_recipient", "note_invite");

    const items = await listInvitesForSender("usr_sender");
    assert.deepEqual(
      items.map((i) => i.id),
      ["inv_2"],
      "the claimed invite (inv_1) must not appear in the sender's list"
    );
  });

  it("still lists an unclaimed invite", async () => {
    const items = await listInvitesForSender("usr_sender");
    assert.deepEqual(items.map((i) => i.id).sort(), ["inv_1", "inv_2"]);
  });
});

// Covers the public claim-link path (ClaimView.tsx + claim_tx.ts's claimNote):
// it pays out straight to whatever wallet the claimer connects and never
// calls this backend, so a row claimed that way never gets claimed_at
// stamped by anything else. listInvitesForSender reconciles against the
// chain itself for exactly this case. The chain check is injected as
// listInvitesForSender's second parameter (never the real
// isNullifierUsedOnChain, which would be a live network call) — these rows
// are pushed directly into the fixture per test rather than added to
// resetTables(), so the plain "listInvitesForSender" tests above (which call
// it with no override) never trip the default checker.
describe("listInvitesForSender chain reconciliation", () => {
  const TEST_SECRET_HEX = "0".repeat(63) + "1";

  function pushChainInvite(id = "inv_chain") {
    tables.pending_invites.push({
      id,
      sender_user_id: "usr_sender",
      handle_normalized: "chain@example.com",
      denom: 25_000_000,
      claim_payload: { secret: TEST_SECRET_HEX },
      expires_at: "2026-12-01T00:00:00.000Z",
      delivered_at: null,
      claimed_at: null,
      refunded_at: null,
      created_at: "2026-09-21T00:00:00.000Z",
    });
  }

  // Three ways the injected chain check can resolve, and what each must do to
  // the listing and to pending_invites.claimed_at.
  for (const c of [
    {
      label: "the nullifier is used on-chain",
      checker: async () => true,
      included: false,
      claimedAtSet: true,
    },
    {
      label: "the nullifier is unused on-chain",
      checker: async () => false,
      included: true,
      claimedAtSet: false,
    },
    {
      label: "the RPC check throws",
      checker: async () => {
        throw new Error("simulateTransaction: network unreachable");
      },
      included: true,
      claimedAtSet: false,
    },
  ]) {
    it(`${c.included ? "keeps listing" : "excludes"} the row when ${c.label}`, async () => {
      pushChainInvite();
      const items = await listInvitesForSender("usr_sender", c.checker);
      assert.deepEqual(
        items.map((i) => i.id).sort(),
        c.included ? ["inv_1", "inv_2", "inv_chain"] : ["inv_1", "inv_2"],
        `the listing must match when ${c.label}`
      );
      const claimedAt = tables.pending_invites.find((r) => r.id === "inv_chain")!.claimed_at;
      if (c.claimedAtSet) assert.notEqual(claimedAt, null, "inv_chain's claimed_at should be stamped");
      else assert.equal(claimedAt, null, "inv_chain's claimed_at must stay unset");
    });
  }

  it("computes the nullifier deterministically from the stored secret", () => {
    // Same secret twice must give the same nullifier (sanity check on the
    // helper the reconciliation loop relies on to derive what to check).
    assert.equal(nullifierHexFromSecret(TEST_SECRET_HEX), nullifierHexFromSecret(TEST_SECRET_HEX));
    assert.equal(nullifierHexFromSecret(TEST_SECRET_HEX).length, 64);
  });
});
