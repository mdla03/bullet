import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isStellarAddress, readFilters } from "./dashboard_filters";

const ADDRESS = `G${"A".repeat(55)}`;

test("routes a Stellar address to the wallet lookup", () => {
  assert.equal(isStellarAddress(ADDRESS), true);
  assert.equal(isStellarAddress(`C${"B".repeat(55)}`), true);
  // Survives the sanitiser unchanged, or the lookup would miss.
  assert.equal(readFilters({ q: ADDRESS }).q, ADDRESS);
});

test("leaves anything that is not an address to the handle search", () => {
  assert.equal(isStellarAddress("@alice"), false);
  assert.equal(isStellarAddress("github:alice"), false);
  assert.equal(isStellarAddress(`G${"A".repeat(54)}`), false, "too short");
  assert.equal(isStellarAddress(`G${"A".repeat(56)}`), false, "too long");
  assert.equal(isStellarAddress(`G${"a".repeat(55)}`), false, "lowercase");
  assert.equal(isStellarAddress(`G${"1".repeat(55)}`), false, "not base32");
  assert.equal(isStellarAddress(`X${"A".repeat(55)}`), false, "wrong prefix");
});

test("canonical handles of every account type survive the sanitiser", () => {
  for (const h of ["@alice", "alice@example.com", "github:alice", "discord:a.b", "telegram:alice_1"]) {
    assert.equal(readFilters({ q: h }).q, h);
  }
});


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
