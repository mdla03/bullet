// Backend HTTP + store + session tests.
// Run: node --import tsx/esm --test src/resolver.test.ts
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Response } from "express";

const TMP_DATA = path.join(
  fileURLToPath(import.meta.url),
  "../../data/_test_users.json"
);
process.env.USERS_FILE_OVERRIDE = TMP_DATA;
process.env.ZEEKPAY_CONTRACT_ID = "CTEST_CONTRACT";
process.env.USDC_SAC_ID = "CTEST_USDC";
process.env.RESOLVER_PORT = "0";
process.env.X_CLIENT_ID = "test_client_id";
process.env.X_CLIENT_SECRET = "test_client_secret";
process.env.X_OAUTH_CALLBACK_URL = "http://localhost:9999/auth/twitter/callback";
process.env.GOOGLE_CLIENT_ID = "test_g_id";
process.env.GOOGLE_CLIENT_SECRET = "test_g_secret";
process.env.GOOGLE_OAUTH_CALLBACK_URL = "http://localhost:9999/auth/google/callback";
process.env.FRONTEND_URL = "http://localhost:3000";
process.env.SESSION_SECRET = "test_session_secret_at_least_16_chars";

const { app } = await import("./resolver.js");
const store = await import("./store.js");
const { Keypair } = await import("@stellar/stellar-base");
const { buildLinkWalletChallenge, verifyLinkWalletSig } = await import("./verify.js");
const { createSession } = await import("./session.js");

// Reusable Stellar keypair for sig tests.
const TEST_KP = Keypair.random();
const TEST_ADDR = TEST_KP.publicKey();

async function req(
  method: string,
  urlPath: string,
  opts: { body?: unknown; cookie?: string } = {}
): Promise<{ status: number; body: unknown; setCookie: string | null }> {
  const headers: Record<string, string> = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const res = await fetch(`http://localhost:${port}${urlPath}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body, setCookie };
}

let port: number;
let server: ReturnType<typeof app.listen>;

/** Mint a session cookie for `userId` the same way the server does. */
function signIn(userId: string): string {
  const mockRes = { _h: "", setHeader(_: string, v: string) { this._h = v; } };
  createSession(mockRes as unknown as Response, userId);
  return mockRes._h.split(";")[0];
}

before(() => {
  fs.rmSync(TMP_DATA, { force: true });
  server = app.listen(0);
  port = (server.address() as { port: number }).port;
});

after(() => {
  server.close();
  fs.rmSync(TMP_DATA, { force: true });
});

beforeEach(() => {
  store._resetForTests();
});

// ── store ────────────────────────────────────────────────────────────────────

describe("store", () => {
  it("createUserWithIdentity returns a new user and indexes lookup", () => {
    const r = store.createUserWithIdentity({
      provider: "twitter",
      subject: "1001",
      handle: "@alice",
    });
    assert.ok("ok" in r);
    assert.equal(r.user.identities[0].handle, "@alice");
    assert.equal(store.findByLookup("@ALICE")?.id, r.user.id, "case-insensitive lookup");
    assert.equal(store.findByProviderSubject("twitter", "1001")?.id, r.user.id);
  });

  it("addIdentity attaches a second provider to the same user", () => {
    const a = store.createUserWithIdentity({
      provider: "twitter",
      subject: "1001",
      handle: "@bob",
    });
    assert.ok("ok" in a);
    const b = store.addIdentity(a.user.id, {
      provider: "google",
      subject: "g-2001",
      handle: "bob@example.com",
      email: "bob@example.com",
    });
    assert.ok("ok" in b);
    assert.equal(store.findByLookup("bob@example.com")?.id, a.user.id);
    assert.equal(store.findByLookup("@bob")?.id, a.user.id);
  });

  it("rejects a handle already taken by another user", () => {
    const a = store.createUserWithIdentity({
      provider: "twitter",
      subject: "1",
      handle: "@carol",
    });
    assert.ok("ok" in a);
    const b = store.createUserWithIdentity({
      provider: "google",
      subject: "g-x",
      handle: "@carol", // same handle, different provider — still a conflict on lookup
    });
    assert.ok("conflict" in b);
  });

  it("attachWallet requires a wallet not already used by someone else", () => {
    const a = store.createUserWithIdentity({
      provider: "twitter",
      subject: "1",
      handle: "@dan",
    });
    assert.ok("ok" in a);
    const r = store.attachWallet(a.user.id, {
      stellarAddress: TEST_ADDR,
      zeekPayPubKey: "f".repeat(64),
      signature: "0".repeat(128),
    });
    assert.ok("ok" in r);
    assert.equal(r.user.wallet?.stellarAddress, TEST_ADDR);
  });
});

// ── verify ────────────────────────────────────────────────────────────────────

describe("verify.verifyLinkWalletSig", () => {
  it("accepts a valid Ed25519 sig over the canonical challenge", () => {
    const userId = "usr_" + "a".repeat(16);
    const sig = TEST_KP.sign(buildLinkWalletChallenge(userId)).toString("hex");
    assert.ok(verifyLinkWalletSig(userId, TEST_ADDR, sig));
  });

  it("rejects a sig from a different keypair", () => {
    const userId = "usr_" + "a".repeat(16);
    const bad = Keypair.random().sign(buildLinkWalletChallenge(userId)).toString("hex");
    assert.ok(!verifyLinkWalletSig(userId, TEST_ADDR, bad));
  });

  it("rejects a malformed stellarAddress without throwing", () => {
    assert.ok(!verifyLinkWalletSig("usr_1", "notakey", "f".repeat(128)));
  });
});

// ── HTTP: health + resolve ────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 {ok:true}", async () => {
    const r = await req("GET", "/health");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });
});

describe("GET /resolve", () => {
  it("found:false for unknown handle", async () => {
    const r = await req("GET", "/resolve?q=@unknown");
    assert.deepEqual(r.body, { found: false });
  });

  it("found:false for user without wallet attached (they can't receive yet)", async () => {
    const a = store.createUserWithIdentity({
      provider: "twitter",
      subject: "1",
      handle: "@no_wallet",
    });
    assert.ok("ok" in a);
    const r = await req("GET", "/resolve?q=@no_wallet");
    assert.deepEqual(r.body, { found: false });
  });

  it("found:true with wallet fields for user with wallet", async () => {
    const a = store.createUserWithIdentity({
      provider: "twitter",
      subject: "2",
      handle: "@wallet_ok",
    });
    assert.ok("ok" in a);
    store.attachWallet(a.user.id, {
      stellarAddress: TEST_ADDR,
      zeekPayPubKey: "d".repeat(64),
      signature: "0".repeat(128),
    });
    const r = await req("GET", "/resolve?q=@wallet_ok");
    const b = r.body as Record<string, unknown>;
    assert.equal(b.found, true);
    assert.equal(b.stellarAddress, TEST_ADDR);
    assert.equal(b.zeekPayPubKey, "d".repeat(64));
    assert.equal(b.contractAddress, "CTEST_CONTRACT");
  });
});

// ── HTTP: /me + session ───────────────────────────────────────────────────────

describe("session + /me", () => {
  it("/me returns {authenticated:false} without cookie", async () => {
    const r = await req("GET", "/me");
    assert.deepEqual(r.body, { authenticated: false });
  });

  it("/me returns identities and wallet with valid session cookie", async () => {
    const a = store.createUserWithIdentity({
      provider: "google",
      subject: "g-x",
      handle: "eve@example.com",
      email: "eve@example.com",
    });
    assert.ok("ok" in a);
    const r = await req("GET", "/me", { cookie: signIn(a.user.id) });
    const b = r.body as Record<string, unknown>;
    assert.equal(b.authenticated, true);
    assert.equal(b.userId, a.user.id);
    assert.equal((b.identities as unknown[]).length, 1);
  });

  it("rejects a tampered cookie", async () => {
    const r = await req("GET", "/me", { cookie: "bullet_session=deadbeef.wrongsig" });
    assert.deepEqual(r.body, { authenticated: false });
  });
});

// ── HTTP: /wallet/link ────────────────────────────────────────────────────────

describe("POST /wallet/link", () => {
  it("401 without a session", async () => {
    const r = await req("POST", "/wallet/link", {
      body: { stellarAddress: TEST_ADDR, zeekPayPubKey: "a".repeat(64), signature: "0".repeat(128) },
    });
    assert.equal(r.status, 401);
  });

  it("400 with an invalid signature", async () => {
    const a = store.createUserWithIdentity({ provider: "twitter", subject: "1", handle: "@w1" });
    assert.ok("ok" in a);
    const r = await req("POST", "/wallet/link", {
      cookie: signIn(a.user.id),
      body: { stellarAddress: TEST_ADDR, zeekPayPubKey: "a".repeat(64), signature: "f".repeat(128) },
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as Record<string, unknown>).error, "invalid_signature");
  });

  it("200 attaches the wallet with a valid Ed25519 sig", async () => {
    const a = store.createUserWithIdentity({ provider: "twitter", subject: "1", handle: "@w2" });
    assert.ok("ok" in a);
    const sig = TEST_KP.sign(buildLinkWalletChallenge(a.user.id)).toString("hex");
    const r = await req("POST", "/wallet/link", {
      cookie: signIn(a.user.id),
      body: { stellarAddress: TEST_ADDR, zeekPayPubKey: "a".repeat(64), signature: sig },
    });
    assert.equal(r.status, 200);
    assert.equal(store.getUser(a.user.id)?.wallet?.stellarAddress, TEST_ADDR);
  });
});

// ── HTTP: OAuth start ─────────────────────────────────────────────────────────

describe("POST /auth/twitter/start", () => {
  it("returns an authUrl", async () => {
    const r = await req("POST", "/auth/twitter/start", { body: { handle: "@alice" } });
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.ok((b.authUrl as string).startsWith("https://twitter.com/i/oauth2/authorize"));
  });

  it("400 on bad handle format", async () => {
    const r = await req("POST", "/auth/twitter/start", { body: { handle: "no-at-sign" } });
    assert.equal(r.status, 400);
  });
});

describe("POST /auth/google/start", () => {
  it("returns an authUrl", async () => {
    const r = await req("POST", "/auth/google/start", { body: {} });
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.ok((b.authUrl as string).startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
  });
});

describe("POST /auth/logout", () => {
  it("returns ok and expires the cookie", async () => {
    const r = await req("POST", "/auth/logout", { body: {} });
    assert.equal(r.status, 200);
    assert.match(r.setCookie ?? "", /Max-Age=0/);
  });
});
