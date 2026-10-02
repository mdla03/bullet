import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFilters } from "./dashboard_filters";

test("keeps the values a handle or a tx hash is made of", () => {
  const f = readFilters({
    type: "claim",
    token: "2",
    from: "2026-01-02",
    to: "2026-03-04",
    q: "alice@example.com",
    page: "3",
  });
  assert.deepEqual(f, {
    type: "claim",
    token: "2",
    from: "2026-01-02",
    to: "2026-03-04",
    q: "alice@example.com",
    page: 3,
  });
});

test("drops anything that would break out of the PostgREST or() filter", () => {
  // A comma starts a new condition, parens close the or group, `%` and `*`
  // are ilike wildcards. None of them may survive into the filter string.
  const { q } = readFilters({ q: "a,tx_hash.ilike.*)" });
  assert.equal(q, "atx_hash.ilike.");
  assert.equal(readFilters({ q: "100%" }).q, "100");
});

test("rejects values that are not of the shape the query expects", () => {
  const f = readFilters({
    type: "delete",
    token: "1; drop",
    from: "yesterday",
    to: "2026-13",
    page: "-5",
  });
  assert.deepEqual(f, { type: "", token: "", from: "", to: "", q: "", page: 0 });
});

test("takes the first value when a param is repeated", () => {
  assert.equal(readFilters({ type: ["send", "claim"] }).type, "send");
});
