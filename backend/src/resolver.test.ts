// Tests for resolver-service: store + HTTP endpoints.
// Run: node --import tsx/esm --test src/resolver.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Point the store at a temp registry so tests don't touch real data ─────────
const TMP_DATA = path.join(
  fileURLToPath(import.meta.url),
  "../../data/_test_registry.json"
);
process.env.REGISTRY_FILE_OVERRIDE = TMP_DATA;

// Set required env vars before importing app modules.
process.env.ZEEKPAY_CONTRACT_ID = "CTEST_CONTRACT";
process.env.USDC_SAC_ID = "CTEST_USDC";
process.env.RESOLVER_PORT = "0"; // OS assigns a free port
process.env.X_CLIENT_ID = "test_client_id";
process.env.X_CLIENT_SECRET = "test_client_secret";
process.env.X_OAUTH_CALLBACK_URL = "http://localhost:9999/auth/twitter/callback";
process.env.FRONTEND_URL = "http://localhost:3000";

// Import AFTER env is set.
const { app } = await import("./resolver.js");
const { normalizeKey, lookup, register } = await import("./store.js");
const { Keypair } = await import("@stellar/stellar-base");
const { buildChallenge, verifyRegistrationSig } = await import("./verify.js");

// Stable test keypair shared across twitter/verify tests.
const TEST_KP = Keypair.random();
const TEST_ADDR = TEST_KP.publicKey();

// ── helpers ────────────────────────────────────────────────────────────────────

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const VALID_STELLAR = "GBMZMYKDHJKGMZMYKDHJKGMZMYKDHJKGMZMYKDHJKGMZMYKDHJKGMZMY"; // 56 chars
const VALID_KEY = "a".repeat(64);
const VALID_SIG = "deadbeef";

let port: number;
let server: ReturnType<typeof app.listen>;

before(() => {
  // Remove any leftover test registry from a previous run.
  fs.rmSync(TMP_DATA, { force: true });
  server = app.listen(0);
  port = (server.address() as { port: number }).port;
});

after(() => {
  server.close();
  fs.rmSync(TMP_DATA, { force: true });
});

// ── unit: store ────────────────────────────────────────────────────────────────

describe("store.normalizeKey", () => {
  it("lowercases X handles and preserves leading @", () => {
    assert.equal(normalizeKey("@Alice"), "@alice");
    assert.equal(normalizeKey("@BOB"), "@bob");
  });

  it("lowercases emails", () => {
    assert.equal(normalizeKey("User@Example.COM"), "user@example.com");
  });

  it("trims whitespace", () => {
    assert.equal(normalizeKey("  @alice  "), "@alice");
  });
});

describe("store.register + lookup", () => {
  it("registers and retrieves by handle", () => {
    const res = register({
      handle: "@alice",
      stellarAddress: VALID_STELLAR,
      zeekPayPubKey: VALID_KEY,
      signature: VALID_SIG,
    });
    assert.ok("ok" in res);
    const entry = lookup("@alice");
    assert.ok(entry);
    assert.equal(entry.stellarAddress, VALID_STELLAR);
  });

  it("retrieves case-insensitively via normalizeKey", () => {
    assert.ok(lookup(normalizeKey("@ALICE")));
  });

  it("idempotent re-register to same address", () => {
    const res = register({
      handle: "@alice",
      stellarAddress: VALID_STELLAR,
      zeekPayPubKey: VALID_KEY,
      signature: VALID_SIG,
    });
    assert.ok("ok" in res);
  });

  it("conflict when same handle maps to different address", () => {
    const other = "G" + "B".repeat(55);
    const res = register({
      handle: "@alice",
      stellarAddress: other,
      zeekPayPubKey: VALID_KEY,
      signature: VALID_SIG,
    });
    assert.ok("conflict" in res);
  });

  it("registers email + handle independently", () => {
    const res = register({
      handle: "@bob",
      email: "bob@example.com",
      stellarAddress: "G" + "C".repeat(55),
      zeekPayPubKey: "b".repeat(64),
      signature: VALID_SIG,
    });
    assert.ok("ok" in res);
    assert.ok(lookup("@bob"));
    assert.ok(lookup("bob@example.com"));
  });
});

// ── integration: HTTP ─────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 {ok:true}", async () => {
    const r = await req("GET", "/health");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });
});

describe("GET /resolve", () => {
  it("returns found:false for unknown handle", async () => {
    const r = await req("GET", "/resolve?q=@unknown_xyz");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { found: false });
  });

  it("returns found:true with all fields for registered handle", async () => {
    // @alice was registered in store unit tests above.
    const r = await req("GET", "/resolve?q=@alice");
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.equal(b.found, true);
    assert.equal(b.stellarAddress, VALID_STELLAR);
    assert.equal(b.zeekPayPubKey, VALID_KEY);
    assert.equal(b.contractAddress, "CTEST_CONTRACT");
    assert.equal(b.usdcSac, "CTEST_USDC");
  });

  it("resolves case-insensitively", async () => {
    const r = await req("GET", "/resolve?q=@ALICE");
    assert.equal((r.body as Record<string, unknown>).found, true);
  });

  it("returns found:false for empty q", async () => {
    const r = await req("GET", "/resolve?q=");
    assert.deepEqual(r.body, { found: false });
  });
});

describe("POST /register", () => {
  it("404 — endpoint removed (only /auth/twitter/start writes to registry)", async () => {
    const res = await fetch(`http://localhost:${port}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "@carol" }),
    });
    assert.equal(res.status, 404);
  });
});

// ── verify helpers ────────────────────────────────────────────────────────────

describe("verify.buildChallenge", () => {
  it("canonical UTF-8 form", () => {
    const buf = buildChallenge("@alice", "GADDR");
    assert.equal(buf.toString("utf8"), "zeekpay-register-v1:@alice:GADDR");
  });
});

describe("verify.verifyRegistrationSig", () => {
  it("accepts valid Ed25519 sig", () => {
    const challenge = buildChallenge("@testuser", TEST_ADDR);
    const sig = TEST_KP.sign(challenge).toString("hex");
    assert.ok(verifyRegistrationSig("@testuser", TEST_ADDR, sig));
  });

  it("rejects mutated sig (one bit flipped)", () => {
    const challenge = buildChallenge("@testuser", TEST_ADDR);
    const sigBuf = Buffer.from(TEST_KP.sign(challenge));
    sigBuf[0] ^= 0xff;
    assert.ok(!verifyRegistrationSig("@testuser", TEST_ADDR, sigBuf.toString("hex")));
  });

  it("rejects sig from different keypair", () => {
    const otherKp = Keypair.random();
    const challenge = buildChallenge("@testuser", TEST_ADDR);
    const sig = otherKp.sign(challenge).toString("hex");
    assert.ok(!verifyRegistrationSig("@testuser", TEST_ADDR, sig));
  });

  it("rejects invalid stellarAddress without throwing", () => {
    assert.ok(!verifyRegistrationSig("@testuser", "notakey", "f".repeat(128)));
  });
});

// ── POST /auth/twitter/start ──────────────────────────────────────────────────

function validStartBody(handle = "@testuser") {
  const challenge = buildChallenge(handle, TEST_ADDR);
  const sig = TEST_KP.sign(challenge).toString("hex");
  return { handle, stellarAddress: TEST_ADDR, zeekPayPubKey: "e".repeat(64), signature: sig };
}

describe("POST /auth/twitter/start", () => {
  it("200 returns authUrl for valid request", async () => {
    const r = await req("POST", "/auth/twitter/start", validStartBody());
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.ok(typeof b.authUrl === "string", "authUrl should be string");
    assert.ok(
      (b.authUrl as string).startsWith("https://twitter.com/i/oauth2/authorize"),
      `unexpected authUrl: ${b.authUrl}`
    );
  });

  it("400 — wrong signature (all f's)", async () => {
    const body = { ...validStartBody(), signature: "f".repeat(128) };
    const r = await req("POST", "/auth/twitter/start", body);
    assert.equal(r.status, 400);
    assert.equal((r.body as Record<string, unknown>).error, "invalid_signature");
  });

  it("400 — signature wrong length (not 128 hex chars)", async () => {
    const body = { ...validStartBody(), signature: "abcd" };
    const r = await req("POST", "/auth/twitter/start", body);
    assert.equal(r.status, 400);
  });

  it("400 — invalid stellarAddress", async () => {
    const body = { ...validStartBody(), stellarAddress: "notakey" };
    const r = await req("POST", "/auth/twitter/start", body);
    assert.equal(r.status, 400);
  });

  it("400 — handle missing @", async () => {
    const body = { ...validStartBody(), handle: "alice" };
    const r = await req("POST", "/auth/twitter/start", body);
    assert.equal(r.status, 400);
  });

  it("503 — X_CLIENT_ID unset", async () => {
    const saved = process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_ID;
    const r = await req("POST", "/auth/twitter/start", validStartBody());
    process.env.X_CLIENT_ID = saved;
    assert.equal(r.status, 503);
  });
});

// ── GET /auth/twitter/callback ────────────────────────────────────────────────

async function getCallback(qs: string) {
  return fetch(`http://localhost:${port}/auth/twitter/callback?${qs}`, {
    redirect: "manual",
  });
}

describe("GET /auth/twitter/callback", () => {
  it("302 error=expired for unknown state", async () => {
    const res = await getCallback("code=abc&state=nonexistent_state");
    assert.equal(res.status, 302);
    assert.ok(
      (res.headers.get("location") ?? "").includes("error=expired"),
      `location: ${res.headers.get("location")}`
    );
  });

  it("302 error=cancelled when ?error param present", async () => {
    const res = await getCallback("error=access_denied&state=x");
    assert.equal(res.status, 302);
    assert.ok((res.headers.get("location") ?? "").includes("error=cancelled"));
  });

  it("302 error=invalid_request when state or code missing", async () => {
    const res = await getCallback("code=abc");
    assert.equal(res.status, 302);
    assert.ok((res.headers.get("location") ?? "").includes("error=invalid_request"));
  });
});
