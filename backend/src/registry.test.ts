// D3: pluggable handle-type registry + GitHub ownership-proof checks.
// Run: node --import tsx/esm --test src/registry.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enabledHandleTypes,
  verifyHandleTypeOwnership,
} from "@zeekpay/shared";

// One representative raw input per enabled type, chosen to exercise the "@"
// stripping / casing normalization each parser does.
const SAMPLE_INPUT: Record<string, string> = {
  google: "Alice@Example.com",
  x: "@Alice",
  email: "Alice@Example.com",
  github: "@Torvalds",
};

describe("handle registry: parse/format round trip", () => {
  for (const handleType of enabledHandleTypes()) {
    it(`${handleType.id}: parse -> format -> parse is stable`, () => {
      const raw = SAMPLE_INPUT[handleType.id];
      assert.ok(raw, `no sample input configured for ${handleType.id}`);

      const canonical = handleType.parse(raw);
      assert.ok(canonical, `${handleType.id}.parse(${JSON.stringify(raw)}) returned null`);

      const displayed = handleType.format(canonical!);
      assert.equal(typeof displayed, "string");

      // Formatting only ever adds display sugar (e.g. a leading "@"); parsing
      // the displayed form must recover the exact same canonical value.
      const reparsed = handleType.parse(displayed);
      assert.equal(reparsed, canonical);
    });

    it(`${handleType.id}: parse rejects empty input`, () => {
      assert.equal(handleType.parse(""), null);
    });
  }

  it("disabled types (discord, telegram) are not in the enabled list", () => {
    const ids = enabledHandleTypes().map((h) => h.id);
    assert.ok(!ids.includes("discord"));
    assert.ok(!ids.includes("telegram"));
  });
});

describe("verifyHandleTypeOwnership", () => {
  it("accepts github when the caller has a github identity", () => {
    const result = verifyHandleTypeOwnership("github", ["github"]);
    assert.deepEqual(result, { ok: true });
  });

  it("rejects github when the JWT's identities don't include github", () => {
    const result = verifyHandleTypeOwnership("github", ["google"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "provider_mismatch");
  });

  it("rejects github for a caller with no identities at all", () => {
    const result = verifyHandleTypeOwnership("github", []);
    assert.equal(result.ok, false);
    assert.equal(result.error, "provider_mismatch");
  });

  it("rejects a disabled handle type (telegram) even with a matching provider", () => {
    // telegram uses the widget proof, not supabase-oauth, but disabled is
    // checked first so this still reports handle_type_disabled.
    const result = verifyHandleTypeOwnership("telegram", ["telegram"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "handle_type_disabled");
  });

  it("rejects email: it's proven by OTP, not an OAuth identity", () => {
    const result = verifyHandleTypeOwnership("email", ["email"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "not_oauth_backed");
  });

  it("rejects an unknown handle type", () => {
    const result = verifyHandleTypeOwnership("carrier_pigeon", ["github"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "unknown_handle_type");
  });
});
