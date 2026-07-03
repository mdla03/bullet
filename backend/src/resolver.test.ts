// Backend HTTP tests. Store/auth flows that need real Supabase are exercised
// end-to-end from the frontend; this file covers the public surface and the
// Ed25519 wallet-link signature verifier.
// Run: node --import tsx/esm --test src/resolver.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.ZEEKPAY_CONTRACT_ID = "CTEST_CONTRACT";
process.env.USDC_SAC_ID = "CTEST_USDC";
process.env.RESOLVER_PORT = "0";
process.env.FRONTEND_URL = "http://localhost:3000";
process.env.SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "placeholder_anon_key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder_service_role_key";

const { app } = await import("./resolver.js");
const { Keypair } = await import("@stellar/stellar-base");
const { buildLinkWalletChallenge, verifyLinkWalletSig } = await import("./verify.js");

const TEST_KP = Keypair.random();
const TEST_ADDR = TEST_KP.publicKey();

async function req(
  method: string,
  urlPath: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`http://localhost:${port}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed };
}

let port: number;
let server: ReturnType<typeof app.listen>;

before(() => {
  server = app.listen(0);
  port = (server.address() as { port: number }).port;
});

after(() => {
  server.close();
});

// ── verify (unit) ─────────────────────────────────────────────────────────────

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

// ── HTTP surface (no Supabase side effects) ───────────────────────────────────

describe("GET /health", () => {
  it("returns 200 {ok:true}", async () => {
    const r = await req("GET", "/health");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });
});

describe("GET /resolve", () => {
  it("returns found:false for empty query", async () => {
    const r = await req("GET", "/resolve?q=");
    assert.deepEqual(r.body, { found: false });
  });

  it("returns found:false for oversized query without hitting Supabase", async () => {
    const r = await req("GET", "/resolve?q=" + "a".repeat(300));
    assert.deepEqual(r.body, { found: false });
  });
});

describe("POST /wallet/link", () => {
  it("401 without an Authorization header", async () => {
    const r = await req("POST", "/wallet/link", {
      stellarAddress: TEST_ADDR,
      zeekPayPubKey: "a".repeat(64),
      signature: "0".repeat(128),
    });
    assert.equal(r.status, 401);
  });
});
