import { strict as assert } from "node:assert";
import { test } from "node:test";
import { WIDGET_ORIGIN, parseWidgetMessage, widgetSrc } from "./telegram-widget.js";

const AUTH = JSON.stringify({
  event: "auth_user",
  auth_data: { id: 7, username: "someone", auth_date: 1, hash: "ab" },
});

test("widgetSrc points at the bot's embed with the caller's origin", () => {
  const src = widgetSrc("sendbullet_bot", "https://sendbullet.xyz", "https://sendbullet.xyz/account");
  const url = new URL(src);
  assert.equal(url.origin, WIDGET_ORIGIN);
  assert.equal(url.pathname, "/embed/sendbullet_bot");
  assert.equal(url.searchParams.get("origin"), "https://sendbullet.xyz");
  assert.equal(url.searchParams.get("return_to"), "https://sendbullet.xyz/account");
  assert.equal(url.searchParams.get("size"), "large");
});

test("an untrusted event yields nothing, whatever it carries", () => {
  // The caller has already decided origin and source do not match. A payload
  // that would otherwise link a handle must not survive that.
  assert.equal(parseWidgetMessage(false, AUTH), null);
});

test("an auth payload is passed through unchanged", () => {
  const msg = parseWidgetMessage(true, AUTH);
  assert.equal(msg?.type, "auth");
  // Telegram's hash covers these exact fields: re-shaping breaks verification.
  assert.deepEqual(msg?.type === "auth" ? msg.user : null, {
    id: 7,
    username: "someone",
    auth_date: 1,
    hash: "ab",
  });
});

test("an auth_user event with no auth_data is ignored", () => {
  assert.equal(parseWidgetMessage(true, JSON.stringify({ event: "auth_user" })), null);
});

test("resize carries the frame's own numbers, and only numbers", () => {
  assert.deepEqual(parseWidgetMessage(true, JSON.stringify({ event: "resize", width: 238, height: 40 })), {
    type: "resize",
    width: 238,
    height: 40,
  });
  assert.deepEqual(parseWidgetMessage(true, JSON.stringify({ event: "resize", height: "40px" })), {
    type: "resize",
    width: undefined,
    height: undefined,
  });
});

test("noise is ignored rather than thrown on", () => {
  assert.equal(parseWidgetMessage(true, "not json"), null);
  assert.equal(parseWidgetMessage(true, JSON.stringify({ event: "ready" })), null);
  assert.equal(parseWidgetMessage(true, { event: "auth_user" }), null);
});
