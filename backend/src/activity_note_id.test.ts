// activity.note_id: which rows are allowed to carry it.
//
// A claim row pointing at a note is fine: notes carry no sender identity, so it
// reaches nothing the claimer does not already own. A SEND row pointing at one
// would link a sender to the recipient's note, which is exactly the cross-user
// link activity.sql exists to prevent. insertActivity is the only writer, so
// that is where the rule is enforced and where it is tested.
//
// Run: node --import tsx/esm --experimental-test-module-mocks --test src/activity_note_id.test.ts
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "placeholder_anon_key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder_service_role_key";

// Capture what store.ts hands to Postgres. Only `activity` inserts are used
// here, so a single-table stub is enough.
const inserted: Record<string, unknown>[] = [];
mock.module("./supabase.js", {
  namedExports: {
    serviceClient: {
      from: (table: string) => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, ...row });
          return Promise.resolve({ error: null });
        },
      }),
    },
  },
});

const { insertActivity } = await import("./store.js");

const USER = "11111111-1111-1111-1111-111111111111";
const NOTE = "22222222-2222-2222-2222-222222222222";

describe("activity.note_id", () => {
  it("keeps the note id on a claim row", async () => {
    inserted.length = 0;
    const ok = await insertActivity(USER, {
      type: "claim",
      amount: 500_000_000,
      tx_hash: "abc123",
      note_id: NOTE,
    });
    assert.equal(ok, true);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].table, "activity");
    assert.equal(inserted[0].note_id, NOTE);
    assert.equal(inserted[0].tx_hash, "abc123");
  });

  it("drops a note id supplied on a send row", async () => {
    inserted.length = 0;
    // A caller passing noteId on a send is the case that matters: the endpoint
    // forwards the field for both types, so this function is the only thing
    // standing between a malicious sender and a sender->recipient link.
    const ok = await insertActivity(USER, {
      type: "send",
      amount: 500_000_000,
      handle: "@someone",
      note_id: NOTE,
    });
    assert.equal(ok, true);
    assert.equal(inserted.length, 1);
    assert.equal(
      inserted[0].note_id,
      null,
      "a send row must never reference a note"
    );
    // The rest of the send row is untouched; only the link is stripped.
    assert.equal(inserted[0].handle, "@someone");
  });

  it("writes null, not undefined, when no note id is given", async () => {
    inserted.length = 0;
    await insertActivity(USER, { type: "claim", amount: 1 });
    assert.equal(inserted.length, 1);
    assert.ok("note_id" in inserted[0]);
    assert.equal(inserted[0].note_id, null);
  });
});
