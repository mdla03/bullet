// Backend HTTP tests. Store/auth flows that need real Supabase are exercised
// end-to-end from the frontend; this file covers the public surface and the
// Ed25519 wallet-link signature verifier.
// Run: node --import tsx/esm --experimental-test-module-mocks --test src/resolver.test.ts
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { ResolveCandidate, ResolveResult } from "@zeekpay/shared";

process.env.ZEEKPAY_CONTRACT_ID = "CTEST_CONTRACT";
process.env.USDC_SAC_ID = "CTEST_USDC";
process.env.RESOLVER_PORT = "0";
process.env.FRONTEND_URL = "http://localhost:3000";
process.env.SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "placeholder_anon_key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder_service_role_key";

// Fake "handles" + "wallets" tables for /resolve. store.js talks to real
// Supabase, which these placeholder creds cannot reach, so the two functions
// /resolve calls are mocked at the module boundary instead
// (--experimental-test-module-mocks). Nothing else in this file touches
// store.js, so mocking the whole module here is safe.
const GH_USER = { id: "usr_gh_torvalds", stellarAddress: "GGH000000000000000000000000000000000000000000000TORV", pubKey: "1".repeat(64) };
const X_USER = { id: "usr_x_muskaroo", stellarAddress: "GX0000000000000000000000000000000000000000000MUSKAROO", pubKey: "2".repeat(64) };
const EMAIL_USER = { id: "usr_email_bob", stellarAddress: "GEMAIL00000000000000000000000000000000000000000000BOB", pubKey: "3".repeat(64) };
const AMBIG_X_USER = { id: "usr_amb_x_alice", stellarAddress: "GAMBX0000000000000000000000000000000000000000000ALICE", pubKey: "4".repeat(64) };
const AMBIG_GH_USER = { id: "usr_amb_gh_alice", stellarAddress: "GAMBGH000000000000000000000000000000000000000000ALICE", pubKey: "5".repeat(64) };
const DUAL_USER = { id: "usr_dual_dana", stellarAddress: "GDUAL0000000000000000000000000000000000000000000DANA", pubKey: "6".repeat(64) };
const BOTH_USER = { id: "usr_both_zelda", stellarAddress: "GBOTH0000000000000000000000000000000000000000000ZELDA", pubKey: "7".repeat(64) };
const ALL_FAKE_USERS = [GH_USER, X_USER, EMAIL_USER, AMBIG_X_USER, AMBIG_GH_USER, DUAL_USER, BOTH_USER];

const FAKE_HANDLES = [
  { handle_normalized: "github:torvalds", user_id: GH_USER.id, avatar_url: "https://avatars.githubusercontent.com/u/1" },
  { handle_normalized: "@muskaroo", user_id: X_USER.id, avatar_url: null },
  { handle_normalized: "bob@example.com", user_id: EMAIL_USER.id, avatar_url: null },
  // Deliberately ambiguous: the same bare name "alice" is claimed by an X
  // user and, separately, a github user.
  { handle_normalized: "@alice", user_id: AMBIG_X_USER.id, avatar_url: null },
  { handle_normalized: "github:alice", user_id: AMBIG_GH_USER.id, avatar_url: "https://avatars.githubusercontent.com/u/2" },
  // Two rows, same handle_normalized: the unique index on handle_normalized
  // (backend/sql/handles_schema.sql) forbids this in production, and the
  // trigger never inserts a second row that would collide with it (see the
  // delete's user-scope comment in handles_github.sql). This fixture only
  // pins the defensive distinctUserIds.length === 1 branch below, which
  // stays correct if that invariant is ever violated some other way.
  { handle_normalized: "dana@example.com", user_id: DUAL_USER.id, avatar_url: null },
  { handle_normalized: "dana@example.com", user_id: DUAL_USER.id, avatar_url: null },
  // One real person, two different handle types linked under the same
  // display name ("zelda" on both GitHub and X) - not ambiguous (one
  // user_id). GitHub row listed first on purpose; see resolver.ts's
  // matchedRow comment for why the order must not matter.
  { handle_normalized: "github:zelda", user_id: BOTH_USER.id, avatar_url: "https://avatars.githubusercontent.com/u/9" },
  { handle_normalized: "@zelda", user_id: BOTH_USER.id, avatar_url: null },
];

// store.js exports more than /resolve needs. Anything not stubbed below gets
// a Proxy fallback that throws a clear error instead of letting the caller
// hit "undefined is not a function".
const STORE_STUBS = {
  findManyByLookup: async (candidates: string[]) =>
    FAKE_HANDLES.filter((h) => candidates.includes(h.handle_normalized)),
  getUser: async (userId: string) => {
    const u = ALL_FAKE_USERS.find((u) => u.id === userId);
    if (!u) return null;
    return {
      id: u.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      identities: [],
      wallet: {
        user_id: u.id,
        stellar_address: u.stellarAddress,
        bullet_pubkey: u.pubKey,
        signature: "sig",
        attached_at: "2026-01-01T00:00:00.000Z",
        previous: [],
      },
      unreadCount: 0,
    };
  },
};
// Derived from the real module instead of hand-listed, so a new store.js
// export is caught here rather than drifting silently. Imported before
// mock.module() below, while "./store.js" still resolves to the real file.
const STORE_UNSTUBBED = Object.keys(await import("./store.js")).filter(
  (k) => !(k in STORE_STUBS)
);
function notStubbed(name: string) {
  return () => {
    throw new Error(`store mock: ${name} not stubbed in resolver.test.ts`);
  };
}
function storeProp(target: Record<string, unknown>, prop: PropertyKey): unknown {
  if (Reflect.has(target, prop)) return Reflect.get(target, prop);
  return typeof prop === "string" ? notStubbed(prop) : undefined;
}
const storeMock: Record<string, unknown> = new Proxy(STORE_STUBS as Record<string, unknown>, {
  get(target, prop) {
    return storeProp(target, prop);
  },
  ownKeys(target) {
    return [...Reflect.ownKeys(target), ...STORE_UNSTUBBED];
  },
  getOwnPropertyDescriptor(target, prop) {
    if (Reflect.has(target, prop) || (typeof prop === "string" && STORE_UNSTUBBED.includes(prop))) {
      return { enumerable: true, configurable: true, value: storeProp(target, prop) };
    }
    return undefined;
  },
});

mock.module("./store.js", { namedExports: storeMock });

// github.js hits the real GitHub API (githubUserExists); stub it so /resolve's
// unregistered-GitHub candidate tests below run offline and deterministically.
// "realuser" and "brandnew" stand in for genuine GitHub logins nobody has
// registered on Bullet yet; everything else (including gibberish that merely
// matches GitHub's username syntax) is "unconfirmed".
mock.module("./github.js", {
  namedExports: {
    githubUserExists: async (login: string) => login === "realuser" || login === "brandnew",
  },
});

const { app, rateLimit } = await import("./resolver.js");
const { Keypair, hash } = await import("@stellar/stellar-base");
const { buildLinkWalletChallenge, verifyLinkWalletSig } = await import("./verify.js");

const TEST_KP = Keypair.random();
const TEST_ADDR = TEST_KP.publicKey();

// Mirror Freighter's SEP-53 signMessage: ed25519 over SHA-256(prefix ‖ message).
function sep53Sign(kp: InstanceType<typeof Keypair>, msg: Buffer): string {
  const prefix = Buffer.from("Stellar Signed Message:\n", "utf8");
  const payload = new Uint8Array(prefix.length + msg.length);
  payload.set(prefix, 0);
  payload.set(msg, prefix.length);
  return kp.sign(hash(Buffer.from(payload))).toString("hex");
}

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
  it("accepts a valid SEP-53 sig over the canonical challenge", () => {
    const userId = "usr_" + "a".repeat(16);
    const sig = sep53Sign(TEST_KP, buildLinkWalletChallenge(userId));
    assert.ok(verifyLinkWalletSig(userId, TEST_ADDR, sig));
  });

  it("rejects a sig from a different keypair", () => {
    const userId = "usr_" + "a".repeat(16);
    const bad = sep53Sign(Keypair.random(), buildLinkWalletChallenge(userId));
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

// /resolve is rate-limited at 20 requests per minute per IP and the whole
// suite shares one IP, so this block has a budget: keep the request count
// comfortably under 20 or the last cases start coming back 429.
describe("GET /resolve", () => {
  it("returns found:false for empty query", async () => {
    const r = await req("GET", "/resolve?q=");
    assert.deepEqual(r.body, { found: false, candidates: [] });
  });

  it("returns found:false for oversized query without hitting Supabase", async () => {
    const r = await req("GET", "/resolve?q=" + "a".repeat(300));
    assert.deepEqual(r.body, { found: false, candidates: [] });
  });

  it("resolves a bare github login (no @, no namespace)", async () => {
    const r = await req("GET", "/resolve?q=torvalds");
    assert.equal(r.status, 200);
    const body = r.body as ResolveResult;
    assert.equal(body.found, true);
    assert.equal(body.stellarAddress, GH_USER.stellarAddress);
    // Carries the registry metadata and the stored row's avatar/profile, so
    // the send form can show a real face and a link the sender can verify.
    assert.equal(body.type, "github");
    assert.equal(body.avatarUrl, "https://avatars.githubusercontent.com/u/1");
    assert.equal(body.profileUrl, "https://github.com/torvalds");
  });

  it("resolves an @-prefixed github login", async () => {
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("@torvalds"));
    assert.equal(r.status, 200);
    assert.equal((r.body as { stellarAddress: string }).stellarAddress, GH_USER.stellarAddress);
  });

  it("resolves the fully namespaced github:login canonical form", async () => {
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("github:torvalds"));
    assert.equal(r.status, 200);
    assert.equal((r.body as { stellarAddress: string }).stellarAddress, GH_USER.stellarAddress);
  });

  it("still resolves an email", async () => {
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("bob@example.com"));
    assert.equal(r.status, 200);
    assert.equal((r.body as { stellarAddress: string }).stellarAddress, EMAIL_USER.stellarAddress);
  });

  it("still resolves an X @name", async () => {
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("@muskaroo"));
    assert.equal(r.status, 200);
    assert.equal((r.body as { stellarAddress: string }).stellarAddress, X_USER.stellarAddress);
  });

  it("returns explicit ambiguity (HTTP 300) when a bare name matches two different people", async () => {
    const r = await req("GET", "/resolve?q=alice");
    assert.equal(r.status, 300);
    const body = r.body as { found: boolean; candidates?: ResolveCandidate[] };
    assert.equal(body.found, false);
    // Label + canonical + avatar/profile per candidate, so the client can
    // prompt with "GitHub alice", a real face, and a verify link, rather than
    // the raw namespaced string.
    assert.deepEqual(
      [...(body.candidates ?? [])].sort((a, b) => a.handle.localeCompare(b.handle)),
      [
        { type: "x", label: "X", handle: "@alice", avatarUrl: null, profileUrl: "https://x.com/alice" },
        {
          type: "github",
          label: "GitHub",
          handle: "github:alice",
          avatarUrl: "https://avatars.githubusercontent.com/u/2",
          profileUrl: "https://github.com/alice",
        },
      ]
    );
  });

  it("resolves an unregistered but GitHub-confirmed handle to 404, not 200", async () => {
    // The sender's "send an invite instead" branch keys off this status, so a
    // not-found must not look like the 300 above, which also has found:false.
    // GitHub is the exception: nobody owns this login on Bullet, but GitHub's
    // API (stubbed above) confirms "realuser" is a real account, so the
    // candidate list still carries GitHub's public avatar redirect and
    // profile link.
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("github:realuser"));
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, {
      found: false,
      candidates: [
        {
          type: "github",
          label: "GitHub",
          handle: "github:realuser",
          avatarUrl: "https://github.com/realuser.png",
          profileUrl: "https://github.com/realuser",
        },
      ],
    });
  });

  it("does not fabricate a GitHub match for a login GitHub does not confirm exists", async () => {
    // Bug: the 404 candidate builder used to construct the avatar/profile
    // from the raw input alone, with no check that the account exists - so
    // gibberish that merely fits GitHub's username syntax (letters/digits,
    // <= 39 chars) rendered a real-looking "found" person card. This string
    // is 23 chars (too long for X's 15-char limit) and not a confirmed GitHub
    // login (the githubUserExists stub above), so it must resolve to an empty
    // candidate list, not a fabricated GitHub entry.
    const r = await req(
      "GET",
      "/resolve?q=" + encodeURIComponent("sxjvkbsdhgkjwehgkjwehui")
    );
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { found: false, candidates: [] });
  });

  it("resolves an unregistered X handle to a 404 with just an X candidate (no fallback avatar)", async () => {
    // Only github ever needs confirmation before appearing; every other
    // type's parse() succeeding is enough. The underscore makes this string
    // parse as X but not as github (github's charset has no underscore), so
    // there is exactly one, unverified (avatarUrl:null) candidate.
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("@no_body_here"));
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, {
      found: false,
      candidates: [
        {
          type: "x",
          label: "X",
          handle: "@no_body_here",
          avatarUrl: null,
          profileUrl: "https://x.com/no_body_here",
        },
      ],
    });
  });

  it("offers both X and a confirmed GitHub login as candidates for a bare unregistered name", async () => {
    // "brandnew" is unregistered but parses as both a valid X handle and a
    // GitHub login the stub confirms exists - each is a different real
    // recipient, so /resolve must offer both rather than picking one.
    const r = await req("GET", "/resolve?q=brandnew");
    assert.equal(r.status, 404);
    const body = r.body as { found: boolean; candidates?: ResolveCandidate[] };
    assert.deepEqual(
      [...(body.candidates ?? [])].sort((a, b) => a.handle.localeCompare(b.handle)),
      [
        { type: "x", label: "X", handle: "@brandnew", avatarUrl: null, profileUrl: "https://x.com/brandnew" },
        {
          type: "github",
          label: "GitHub",
          handle: "github:brandnew",
          avatarUrl: "https://github.com/brandnew.png",
          profileUrl: "https://github.com/brandnew",
        },
      ]
    );
  });

  // Regression guard, not a test of the exact-canonical rule: "github:alice"
  // parses to one candidate (parseX rejects it), so only one row comes back
  // and the ambiguity branch is never entered. Verified by mutation: with the
  // exact-match rule disabled this case still passes, and only the "@Alice"
  // case below fails. That one is the rule's real guard, because "@Alice"
  // parses to both "@alice" and "github:alice".
  it("exact canonical wins: github:alice picks the github user, no 300", async () => {
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("github:alice"));
    assert.equal(r.status, 200);
    assert.equal(
      (r.body as { stellarAddress: string }).stellarAddress,
      AMBIG_GH_USER.stellarAddress
    );
  });

  it("exact canonical wins case-insensitively: @Alice picks the X user", async () => {
    // Canonical forms are lowercase, so "@Alice" is the exact canonical form
    // just as much as "@alice" is. Comparing the raw query made this a 300.
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("@Alice"));
    assert.equal(r.status, 200);
    assert.equal(
      (r.body as { stellarAddress: string }).stellarAddress,
      AMBIG_X_USER.stellarAddress
    );
  });

  it("resolves an uppercase email", async () => {
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("BOB@Example.COM"));
    assert.equal(r.status, 200);
    assert.equal(
      (r.body as { stellarAddress: string }).stellarAddress,
      EMAIL_USER.stellarAddress
    );
  });

  it("resolves one user holding both a google and an email row on one address", async () => {
    const r = await req("GET", "/resolve?q=" + encodeURIComponent("dana@example.com"));
    assert.equal(r.status, 200);
    assert.equal(
      (r.body as { stellarAddress: string }).stellarAddress,
      DUAL_USER.stellarAddress
    );
  });

  it("picks X, not whichever row the DB returned first, when one user links both", async () => {
    // See resolver.ts's matchedRow comment (findManyByLookup has no ORDER BY).
    const r = await req("GET", "/resolve?q=zelda");
    assert.equal(r.status, 200);
    const body = r.body as ResolveResult;
    assert.equal(body.stellarAddress, BOTH_USER.stellarAddress);
    assert.equal(body.type, "x");
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

// ── rate limiter (M1, unit — no funding side effects) ─────────────────────────

/** Drive the middleware once; returns 429 if limited, 0 if it called next(). */
function hitLimiter(
  limiter: ReturnType<typeof rateLimit>,
  userId: string
): number {
  let code = 0;
  const res = { status(c: number) { code = c; return { json() {} }; } };
  limiter({ userId } as never, res as never, (() => {}) as never);
  return code;
}

describe("rateLimit (M1)", () => {
  it("allows up to the cap, then 429s the next call", () => {
    const limiter = rateLimit(5, 60_000);
    const key = "usr_rate_" + Date.now();
    const codes = Array.from({ length: 6 }, () => hitLimiter(limiter, key));
    assert.deepEqual(codes.slice(0, 5), [0, 0, 0, 0, 0]); // first 5 pass
    assert.equal(codes[5], 429); // 6th blocked
  });

  it("is keyed per user: a second user is unaffected", () => {
    const limiter = rateLimit(1, 60_000);
    assert.equal(hitLimiter(limiter, "userA"), 0); // A: first ok
    assert.equal(hitLimiter(limiter, "userA"), 429); // A: second blocked
    assert.equal(hitLimiter(limiter, "userB"), 0); // B: independent
  });
});
