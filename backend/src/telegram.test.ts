// Telegram Login Widget verification + POST /telegram/link.
// Run: node --import tsx/esm --experimental-test-module-mocks --test src/telegram.test.ts
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

process.env.SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "placeholder_anon_key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder_service_role_key";

const BOT_TOKEN = "1234567:FAKE-TOKEN-FOR-TESTS";
const TEST_USER_ID = "usr_telegram_tester";

/** Telegram's own signing, reimplemented from the spec rather than called from
 *  telegram.ts: a test that signs with the verifier's own code would pass even
 *  if both sides computed the wrong string. */
function sign(fields: Record<string, string | number>, token = BOT_TOKEN): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHash("sha256").update(token).digest();
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

/** A payload Telegram could really have sent, `ageSeconds` old relative to
 *  `base`. The unit tests pin `base` to NOW and pass the same value into
 *  verifyTelegramLogin; the route tests leave it at the real clock, because the
 *  route calls the verifier with Date.now() and cannot be told otherwise. */
function payload(
  overrides: Record<string, string | number> = {},
  ageSeconds = 30,
  base = NOW
): Record<string, string | number> {
  const fields = {
    id: 8675309,
    first_name: "Ada",
    last_name: "Lovelace",
    username: "ada_lovelace",
    photo_url: "https://t.me/i/userpic/320/ada.jpg",
    auth_date: Math.floor(base / 1000) - ageSeconds,
    ...overrides,
  };
  return { ...fields, hash: sign(fields) };
}

/** Same, signed against the real clock, for the HTTP tests. */
function livePayload(overrides: Record<string, string | number> = {}) {
  return payload(overrides, 30, Date.now());
}

// requireAuth talks to Supabase, which the placeholder creds above cannot
// reach, and store.js talks to Postgres. Both are mocked at the module
// boundary so the route's own logic (503, 400, the store call it makes) is
// what gets exercised. Same Proxy pattern as resolver.test.ts: anything not
// stubbed throws by name instead of being undefined.
const upsertCalls: unknown[][] = [];
let upsertResult = true;
const STORE_STUBS = {
  upsertTelegramHandle: async (...args: unknown[]) => {
    upsertCalls.push(args);
    return upsertResult;
  },
};
const STORE_UNSTUBBED = Object.keys(await import("./store.js")).filter(
  (k) => !(k in STORE_STUBS)
);
function storeProp(target: Record<string, unknown>, prop: PropertyKey): unknown {
  if (Reflect.has(target, prop)) return Reflect.get(target, prop);
  if (typeof prop !== "string") return undefined;
  return () => {
    throw new Error(`store mock: ${prop} not stubbed in telegram.test.ts`);
  };
}
const storeMock: Record<string, unknown> = new Proxy(STORE_STUBS as Record<string, unknown>, {
  get: (target, prop) => storeProp(target, prop),
  ownKeys: (target) => [...Reflect.ownKeys(target), ...STORE_UNSTUBBED],
  getOwnPropertyDescriptor(target, prop) {
    if (Reflect.has(target, prop) || (typeof prop === "string" && STORE_UNSTUBBED.includes(prop))) {
      return { enumerable: true, configurable: true, value: storeProp(target, prop) };
    }
    return undefined;
  },
});
mock.module("./store.js", { namedExports: storeMock });

// A bearer token is still required: the stub 401s without one, so the route
// keeping requireAuth in front of the handler is what this asserts.
mock.module("./supabase.js", {
  namedExports: {
    serviceClient: {},
    verifyJwt: async () => TEST_USER_ID,
    requireAuth: (
      req: { header(n: string): string | undefined; userId?: string },
      res: { status(c: number): { json(b: unknown): void } },
      next: () => void
    ) => {
      if (!(req.header("authorization") ?? "").startsWith("Bearer ")) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      req.userId = TEST_USER_ID;
      next();
    },
  },
});

const express = (await import("express")).default;
const { verifyTelegramLogin, telegramRouter } = await import("./telegram.js");

// ── verifyTelegramLogin (pure) ────────────────────────────────────────────────

describe("verifyTelegramLogin", () => {
  it("accepts a correctly signed, fresh payload", () => {
    const v = verifyTelegramLogin(payload(), BOT_TOKEN, NOW);
    assert.equal(v.subject, "8675309");
    assert.equal(v.handle, "telegram:ada_lovelace");
    assert.equal(v.avatarUrl, "https://t.me/i/userpic/320/ada.jpg");
  });

  it("lowercases the username into the canonical handle", () => {
    const v = verifyTelegramLogin(payload({ username: "Ada_Lovelace" }), BOT_TOKEN, NOW);
    assert.equal(v.handle, "telegram:ada_lovelace");
  });

  it("rejects a payload whose hash is one byte off", () => {
    const p = payload();
    // Flip the last hex digit. Everything else is byte-identical to the
    // accepted payload above, so only the signature check can reject this.
    const h = p.hash as string;
    const flipped = h.slice(0, -1) + (h.slice(-1) === "0" ? "1" : "0");
    assert.throws(
      () => verifyTelegramLogin({ ...p, hash: flipped }, BOT_TOKEN, NOW),
      /signature does not match/
    );
  });

  it("rejects a payload signed with a different bot token", () => {
    const fields = {
      id: 8675309,
      first_name: "Ada",
      username: "ada_lovelace",
      auth_date: Math.floor(NOW / 1000) - 30,
    };
    const forged = { ...fields, hash: sign(fields, "999999:SOMEONE-ELSES-TOKEN") };
    assert.throws(() => verifyTelegramLogin(forged, BOT_TOKEN, NOW), /signature does not match/);
  });

  it("rejects a validly signed payload that is 11 minutes old", () => {
    // Signed correctly with our own token, so only the freshness window can
    // reject it. This is the replay guard.
    assert.throws(
      () => verifyTelegramLogin(payload({}, 11 * 60), BOT_TOKEN, NOW),
      /auth_date is outside the accepted window/
    );
  });

  it("accepts a validly signed payload that is 9 minutes old", () => {
    // Pins the window at 10 minutes from both sides: without this, a verifier
    // that rejected everything older than a second would still pass the test
    // above.
    assert.equal(
      verifyTelegramLogin(payload({}, 9 * 60), BOT_TOKEN, NOW).handle,
      "telegram:ada_lovelace"
    );
  });

  it("rejects a username outside parseTelegram's charset (a dash)", () => {
    assert.throws(
      () => verifyTelegramLogin(payload({ username: "ada-lovelace" }), BOT_TOKEN, NOW),
      /not a usable Telegram handle/
    );
  });

  it("rejects a username shorter than 5 characters", () => {
    assert.throws(
      () => verifyTelegramLogin(payload({ username: "ada" }), BOT_TOKEN, NOW),
      /not a usable Telegram handle/
    );
  });

  it("rejects an account with no username at all", () => {
    const fields = {
      id: 8675309,
      first_name: "Ada",
      auth_date: Math.floor(NOW / 1000) - 30,
    };
    assert.throws(
      () => verifyTelegramLogin({ ...fields, hash: sign(fields) }, BOT_TOKEN, NOW),
      /username missing/
    );
  });

  it("rejects a missing or malformed hash without touching the rest", () => {
    assert.throws(() => verifyTelegramLogin({ id: 1 }, BOT_TOKEN, NOW), /hash missing/);
    assert.throws(
      () => verifyTelegramLogin({ id: 1, hash: "nothex" }, BOT_TOKEN, NOW),
      /hash missing or malformed/
    );
  });

  it("rejects a non-numeric id", () => {
    assert.throws(
      () => verifyTelegramLogin(payload({ id: "8675309x" }), BOT_TOKEN, NOW),
      /id missing or not numeric/
    );
  });

  it("drops a photo_url that is not https", () => {
    const v = verifyTelegramLogin(
      payload({ photo_url: "http://t.me/i/userpic/320/ada.jpg" }),
      BOT_TOKEN,
      NOW
    );
    assert.equal(v.avatarUrl, null);
  });

  it("covers fields it does not know about, so an added Telegram field still verifies", () => {
    const v = verifyTelegramLogin(payload({ some_new_field: "xyz" }), BOT_TOKEN, NOW);
    assert.equal(v.handle, "telegram:ada_lovelace");
  });
});

// ── POST /telegram/link ───────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(telegramRouter((_req, _res, next) => next()));

let port: number;
let server: ReturnType<typeof app.listen>;

before(() => {
  server = app.listen(0);
  port = (server.address() as { port: number }).port;
});
after(() => server.close());

beforeEach(() => {
  upsertCalls.length = 0;
  upsertResult = true;
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
});

async function post(
  body: unknown,
  auth = true
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}/telegram/link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: "Bearer test-token" } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed as Record<string, unknown> };
}

describe("POST /telegram/link", () => {
  it("401s without an Authorization header, before reading the body", async () => {
    const r = await post(livePayload(), false);
    assert.equal(r.status, 401);
    assert.equal(upsertCalls.length, 0);
  });

  it("503s with a plain message when TELEGRAM_BOT_TOKEN is unset", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const r = await post(livePayload());
    assert.equal(r.status, 503);
    assert.equal(r.body.detail, "Telegram linking is not configured on this server.");
    // Fails closed: an unconfigured server must not write a handle it cannot
    // verify ownership of.
    assert.equal(upsertCalls.length, 0);
  });

  it("400s on a bad signature and writes nothing", async () => {
    const r = await post({ ...livePayload(), hash: "0".repeat(64) });
    assert.equal(r.status, 400);
    assert.equal(upsertCalls.length, 0);
  });

  it("400s on a username outside the charset and writes nothing", async () => {
    const r = await post(livePayload({ username: "ada-lovelace" }));
    assert.equal(r.status, 400);
    assert.equal(upsertCalls.length, 0);
  });

  it("links the handle to the signed-in user on a valid payload", async () => {
    const p = livePayload();
    const r = await post(p);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, handle: "telegram:ada_lovelace" });
    // Asserts on what was written and for whom, not just on the status: the
    // row landing on the wrong user is the failure that matters here.
    assert.deepEqual(upsertCalls, [
      [
        TEST_USER_ID,
        {
          subject: "8675309",
          handle: "telegram:ada_lovelace",
          avatarUrl: "https://t.me/i/userpic/320/ada.jpg",
          authDate: p.auth_date,
        },
      ],
    ]);
  });

  it("500s when the store write fails", async () => {
    upsertResult = false;
    const r = await post(livePayload());
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "handle_link_failed");
  });
});
