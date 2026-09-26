import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AUTH_ORIGIN, authUrl, fetchAuthResult, whenClosed } from "./telegram-widget.js";

const BOT = "8950852947";
const ORIGIN = "https://sendbullet.xyz";
const USER = { id: 7, username: "someone", auth_date: 1, hash: "ab" };

/** Stands in for fetch, recording the one call it receives. */
function stubFetch(body: unknown, ok = true) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status: ok ? 200 : 502,
      json: async () => body,
    } as Response;
  };
  return { calls, fn: fn as unknown as typeof fetch };
}

test("authUrl targets the bot's login popup with our origin", () => {
  const url = new URL(authUrl(BOT, ORIGIN));
  assert.equal(url.origin, AUTH_ORIGIN);
  assert.equal(url.pathname, "/auth");
  assert.equal(url.searchParams.get("bot_id"), BOT);
  assert.equal(url.searchParams.get("origin"), ORIGIN);
});

test("an authorized session yields the payload unchanged", async () => {
  const { calls, fn } = stubFetch({ user: USER });
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const user = await fetchAuthResult(BOT, ORIGIN);
    // Telegram's hash covers these exact fields: re-shaping breaks the
    // signature check the backend performs.
    assert.deepEqual(user, USER);
  } finally {
    globalThis.fetch = original;
  }
  // Without credentials the session cookie never goes, and every login reads
  // as a cancel.
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].url, /\/auth\/get\?bot_id=8950852947$/);
});

test("an unfinished login is a cancel, not a failure", async () => {
  const { fn } = stubFetch({ error: "NOT_AUTHORIZED", origin: ORIGIN });
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    assert.equal(await fetchAuthResult(BOT, ORIGIN), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("a failed request throws rather than reading as a cancel", async () => {
  // A browser refusing the cross-site cookie lands here. Swallowing it would
  // leave the button looking like it did nothing, forever.
  const { fn } = stubFetch({}, false);
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    await assert.rejects(() => fetchAuthResult(BOT, ORIGIN), /502/);
  } finally {
    globalThis.fetch = original;
  }
});

test("whenClosed waits for the popup rather than resolving immediately", async () => {
  const popup = { closed: false };
  let resolved = false;
  const done = whenClosed(popup as Window, 1).then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false, "resolved while the popup was still open");
  popup.closed = true;
  await done;
  assert.equal(resolved, true);
});
