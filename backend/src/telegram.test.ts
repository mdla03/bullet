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
/** User id the handles table reports for a Telegram subject, or null for one
 *  that has never signed in here. */
let existingUserForSubject: string | null = null;
const subjectLookups: string[] = [];
const STORE_STUBS = {
  upsertTelegramHandle: async (...args: unknown[]) => {
    upsertCalls.push(args);
    return upsertResult;
  },
  findUserByTelegramSubject: async (subject: string) => {
    subjectLookups.push(subject);
    return existingUserForSubject;
  },
  deleteTelegramHandle: async (userId: string) => {
    deleteCalls.push(userId);
    return deleteResult;
  },
};
const deleteCalls: string[] = [];
let deleteResult = true;
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

// Supabase's admin API, as far as the routes use it. Recording the calls is
// the point: which email a session was minted for is the difference between
// signing someone in and handing them another user's account.
const createUserCalls: { email?: string }[] = [];
const generateLinkCalls: { type: string; email: string }[] = [];
let existingUserEmail: string | null = "ada@example.com";
let existingUserIdentities: { provider: string }[] = [{ provider: "google" }];
let generateLinkFails = false;
const adminStub = {
  getUserById: async (id: string) => ({
    data: {
      user: existingUserEmail
        ? { id, email: existingUserEmail, identities: existingUserIdentities }
        : null,
    },
    error: null,
  }),
  createUser: async (attrs: { email?: string }) => {
    createUserCalls.push(attrs);
    return { data: { user: { id: "usr_created", email: attrs.email } }, error: null };
  },
  generateLink: async (args: { type: string; email: string }) => {
    generateLinkCalls.push(args);
    if (generateLinkFails) return { data: null, error: { message: "nope" } };
    return { data: { properties: { hashed_token: "token_hash_abc" } }, error: null };
  },
};

// A bearer token is still required: the stub 401s without one, so the routes
// keeping requireAuth in front of their handlers is what that asserts.
mock.module("./supabase.js", {
  namedExports: {
    serviceClient: { auth: { admin: adminStub } },
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
const { verifyTelegramLogin, telegramRouter, hasOtherSignIn } = await import("./telegram.js");

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
  subjectLookups.length = 0;
  createUserCalls.length = 0;
  generateLinkCalls.length = 0;
  existingUserForSubject = null;
  existingUserEmail = "ada@example.com";
  existingUserIdentities = [{ provider: "google" }];
  deleteCalls.length = 0;
  deleteResult = true;
  generateLinkFails = false;
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

// ── hasOtherSignIn (pure) ─────────────────────────────────────────────────────

describe("hasOtherSignIn", () => {
  it("counts any OAuth identity", () => {
    assert.equal(
      hasOtherSignIn({ email: null, identities: [{ provider: "google" }] }),
      true
    );
  });

  it("counts a real email address", () => {
    assert.equal(
      hasOtherSignIn({ email: "ada@example.com", identities: [{ provider: "email" }] }),
      true
    );
  });

  it("does not count a .invalid placeholder", () => {
    // An account created by Telegram sign-up carries this address. It can
    // never receive a magic link, so it is not a way back in.
    assert.equal(
      hasOtherSignIn({
        email: "telegram-8675309@telegram.invalid",
        identities: [{ provider: "email" }],
      }),
      false
    );
  });

  it("does not count no identities and no email", () => {
    assert.equal(hasOtherSignIn({ email: null, identities: [] }), false);
    assert.equal(hasOtherSignIn({}), false);
  });
});

// ── DELETE /telegram/link ─────────────────────────────────────────────────────

async function unlink(auth = true): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}/telegram/link`, {
    method: "DELETE",
    headers: auth ? { Authorization: "Bearer test-token" } : {},
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

describe("DELETE /telegram/link", () => {
  it("401s without an Authorization header, deleting nothing", async () => {
    const r = await unlink(false);
    assert.equal(r.status, 401);
    assert.deepEqual(deleteCalls, []);
  });

  it("removes the handle for the signed-in user", async () => {
    const r = await unlink();
    assert.equal(r.status, 200);
    // Scoped to the caller. Deleting for anyone else is the failure that
    // matters, so assert on who, not just on the status.
    assert.deepEqual(deleteCalls, [TEST_USER_ID]);
  });

  it("refuses when Telegram is the only way into the account", async () => {
    // A Telegram sign-up account: placeholder address, no OAuth. Unlinking
    // would lock its owner out permanently.
    existingUserEmail = "telegram-8675309@telegram.invalid";
    existingUserIdentities = [{ provider: "email" }];
    const r = await unlink();
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "last_sign_in_method");
    assert.deepEqual(deleteCalls, [], "deleted the handle despite refusing");
  });

  it("500s when the delete fails", async () => {
    deleteResult = false;
    const r = await unlink();
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "unlink_failed");
  });
});

// ── POST /telegram/signin ─────────────────────────────────────────────────────

async function signin(
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}/telegram/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

describe("POST /telegram/signin", () => {
  it("mints nothing on a bad signature", async () => {
    // The route is unauthenticated, so this check is the only thing between a
    // caller and a session. It must fail before any admin call.
    const r = await signin({ ...livePayload(), hash: "0".repeat(64) });
    assert.equal(r.status, 400);
    assert.deepEqual(generateLinkCalls, []);
    assert.deepEqual(createUserCalls, []);
    assert.deepEqual(upsertCalls, []);
  });

  it("mints nothing on a stale payload", async () => {
    // An hour old: outside the ten-minute window, so a captured payload cannot
    // be replayed into a session later.
    const r = await signin(payload({}, 3600, Date.now()));
    assert.equal(r.status, 400);
    assert.deepEqual(generateLinkCalls, []);
  });

  it("503s when the bot token is unset, without touching Supabase", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const r = await signin(livePayload());
    assert.equal(r.status, 503);
    assert.deepEqual(generateLinkCalls, []);
    assert.deepEqual(createUserCalls, []);
  });

  it("signs an existing account in against its own email", async () => {
    existingUserForSubject = "usr_existing";
    existingUserEmail = "ada@example.com";
    const r = await signin(livePayload());
    assert.equal(r.status, 200);
    assert.equal(r.body.token_hash, "token_hash_abc");
    assert.equal(r.body.created, false);
    // No account was created for someone who already had one.
    assert.deepEqual(createUserCalls, []);
    // The session is minted for the account the handle belongs to. A different
    // email here is a takeover, not a bug in passing.
    assert.deepEqual(generateLinkCalls, [{ type: "magiclink", email: "ada@example.com" }]);
  });

  it("looks the account up by Telegram id, never by username", async () => {
    // Usernames get released and re-registered. Someone who takes over
    // @ada_lovelace must not reach the original owner's account, and the only
    // thing that stops them is which field this lookup uses.
    existingUserForSubject = "usr_existing";
    await signin(livePayload({ id: 999, username: "someone_else" }));
    assert.deepEqual(subjectLookups, ["999"]);
  });

  it("creates an account at an unroutable address on first sign-in", async () => {
    existingUserForSubject = null;
    const r = await signin(livePayload());
    assert.equal(r.status, 200);
    assert.equal(r.body.created, true);
    assert.deepEqual(createUserCalls, [
      { email: "telegram-8675309@telegram.invalid", email_confirm: true },
    ]);
    // .invalid can never resolve, so nothing addressed to it can leave.
    assert.match(String(createUserCalls[0].email), /@telegram\.invalid$/);
    assert.deepEqual(generateLinkCalls, [
      { type: "magiclink", email: "telegram-8675309@telegram.invalid" },
    ]);
  });

  it("writes the handle on every sign-in, not just the first", async () => {
    // A username changed on Telegram's side would otherwise leave the account
    // payable at a name its owner no longer holds.
    existingUserForSubject = "usr_existing";
    await signin(livePayload({ username: "ada_renamed" }));
    assert.equal(upsertCalls.length, 1);
    assert.deepEqual(upsertCalls[0][0], "usr_existing");
    assert.equal(
      (upsertCalls[0][1] as { handle: string }).handle,
      "telegram:ada_renamed"
    );
  });

  it("500s without a token when the link cannot be generated", async () => {
    generateLinkFails = true;
    const r = await signin(livePayload());
    assert.equal(r.status, 500);
    assert.equal(r.body.token_hash, undefined);
  });
});
