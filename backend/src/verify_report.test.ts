// buildReport: what a reviewer is shown, and what is counted as proven.
// Run: node --import tsx/esm --experimental-test-module-mocks --test src/verify_report.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "placeholder_anon_key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder_service_role_key";

const { buildReport } = await import("./verify_report.js");

const AT = "2026-09-28T01:00:00.000Z";

function row(
  user_id: string,
  provider: string,
  handle: string,
  subject = "id-" + handle
) {
  return { user_id, provider, subject, handle, linked_at: AT };
}

describe("buildReport", () => {
  it("counts an account as verified on a platform handle, not an email one", () => {
    const r = buildReport([
      row("u1", "github", "github:torvalds"),
      row("u2", "email", "someone@example.com"),
    ]);
    assert.equal(r.accounts, 2);
    // The whole point of the report: an email address is self-asserted, so it
    // must never be counted as a platform having vouched for anyone.
    assert.equal(r.verifiedAccounts, 1);
  });

  it("counts an account once however many handles it has", () => {
    const r = buildReport([
      row("u1", "github", "github:torvalds"),
      row("u1", "discord", "discord:torvalds"),
      row("u1", "telegram", "telegram:torvalds"),
    ]);
    assert.equal(r.accounts, 1);
    assert.equal(r.verifiedAccounts, 1);
  });

  it("treats X's three provider spellings as one platform", () => {
    const r = buildReport([
      row("u1", "twitter", "@a"),
      row("u2", "twitter_v2", "@b"),
      row("u3", "x", "@c"),
    ]);
    assert.equal(r.verifiedAccounts, 3);
    // One X section, listing all three, rather than three near-duplicate ones.
    assert.equal(r.markdown.match(/^## X /gm)?.length, 1);
    for (const h of ["@a", "@b", "@c"]) assert.match(r.markdown, new RegExp(h));
  });

  it("shows the platform's own id and a resolvable profile link", () => {
    // This is what a reviewer checks against the platform. If either is
    // missing the report proves nothing.
    const r = buildReport([row("u1", "telegram", "telegram:mla032", "8675309")]);
    assert.match(r.markdown, /8675309/);
    assert.match(r.markdown, /https:\/\/t\.me\/mla032/);
  });

  it("gives email-only accounts no section of their own", () => {
    const r = buildReport([row("u1", "email", "someone@example.com")]);
    assert.equal(r.verifiedAccounts, 0);
    // Listing them beside verified handles would imply a proof that does not
    // exist. They stay in the summary count only.
    assert.doesNotMatch(r.markdown, /^## Email/m);
    assert.doesNotMatch(r.markdown, /someone@example\.com/);
  });

  it("counts rows from a disabled type instead of dropping them silently", () => {
    const r = buildReport([row("u1", "myspace", "myspace:tom")]);
    assert.equal(r.unknownProvider, 1);
    assert.equal(r.accounts, 0);
  });

  it("names the two write paths, so the claim can be checked in the repo", () => {
    const r = buildReport([]);
    assert.match(r.markdown, /on_auth_identity_created/);
    assert.match(r.markdown, /link_telegram_handle/);
    assert.match(r.markdown, /verifyTelegramLogin/);
  });
});
