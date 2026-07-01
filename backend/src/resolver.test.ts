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

// Import AFTER env is set.
const { app } = await import("./resolver.js");
const { normalizeKey, lookup, register } = await import("./store.js");

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
  const NEW_ADDR = "G" + "D".repeat(55);

  it("registers new handle successfully", async () => {
    const r = await req("POST", "/register", {
      handle: "@carol",
      stellarAddress: NEW_ADDR,
      zeekPayPubKey: "c".repeat(64),
      signature: VALID_SIG,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });

  it("409 conflict — same handle, different address", async () => {
    const r = await req("POST", "/register", {
      handle: "@carol",
      stellarAddress: "G" + "E".repeat(55),
      zeekPayPubKey: "c".repeat(64),
      signature: VALID_SIG,
    });
    assert.equal(r.status, 409);
  });

  it("400 — missing handle and email", async () => {
    const r = await req("POST", "/register", {
      stellarAddress: NEW_ADDR,
      zeekPayPubKey: "c".repeat(64),
      signature: VALID_SIG,
    });
    assert.equal(r.status, 400);
  });

  it("400 — invalid stellarAddress", async () => {
    const r = await req("POST", "/register", {
      handle: "@dave",
      stellarAddress: "notakey",
      zeekPayPubKey: "d".repeat(64),
      signature: VALID_SIG,
    });
    assert.equal(r.status, 400);
  });

  it("400 — invalid zeekPayPubKey (not 64 hex chars)", async () => {
    const r = await req("POST", "/register", {
      handle: "@dave",
      stellarAddress: NEW_ADDR,
      zeekPayPubKey: "zzzz",
      signature: VALID_SIG,
    });
    assert.equal(r.status, 400);
  });

  it("400 — invalid email format", async () => {
    const r = await req("POST", "/register", {
      email: "notanemail",
      stellarAddress: NEW_ADDR,
      zeekPayPubKey: "d".repeat(64),
      signature: VALID_SIG,
    });
    assert.equal(r.status, 400);
  });
});
