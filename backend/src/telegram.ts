// Telegram handle linking (D3).
//
// Telegram is not a Supabase OAuth provider, so there is no auth.identities row
// for it and the handles trigger (backend/sql/handles_avatar.sql) never fires.
// Proof of control is ours instead: the Telegram Login Widget hands the browser
// a payload signed by Telegram, and this module checks that signature with the
// bot token, which only the backend holds.
//
// Check, per https://core.telegram.org/widgets/login#checking-authorization:
//   secret         = SHA256(bot_token)
//   data_check_str = every received field except `hash`, sorted by key,
//                    rendered "key=value" and joined with "\n"
//   expected       = HMAC_SHA256(data_check_str, secret)
// and `auth_date` must be recent, or a payload captured once could be replayed
// to re-link the handle forever.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { getHandleType } from "@zeekpay/shared";
import { requireAuth } from "./supabase.js";
import * as store from "./store.js";

/** Raw widget payload. Typed open rather than as a closed shape: Telegram has
 *  added fields before, the hash covers every field it sent, and silently
 *  dropping an unknown one from the data-check string would fail every login
 *  the day they add another. */
export type TelegramLoginPayload = Record<string, unknown>;

export interface VerifiedTelegramLogin {
  /** Telegram's numeric user id as text. Stable across username changes, so
   *  this is the handles row's `subject`. */
  subject: string;
  /** Canonical handle, "telegram:<lowercase username>". */
  handle: string;
  /** photo_url, kept only when https (mirrors the SQL trigger's guard). */
  avatarUrl: string | null;
  /** Unix seconds, as Telegram sent it. */
  authDate: number;
}

/** A widget payload older than this is refused. Ten minutes is long enough for
 *  a slow human and a skewed clock, short enough that a payload leaked out of a
 *  browser history or a referrer header is dead by the time it is found. */
export const MAX_AUTH_AGE_MS = 10 * 60 * 1000;

const HASH_RE = /^[0-9a-f]{64}$/i;
const ID_RE = /^\d{1,20}$/;

/** Verifies a Telegram Login Widget payload. Pure: no env, no clock, no I/O, so
 *  every rejection below is reachable from a test. Throws on anything it will
 *  not vouch for; the caller turns that into a 400. */
export function verifyTelegramLogin(
  payload: TelegramLoginPayload,
  botToken: string,
  now: number = Date.now()
): VerifiedTelegramLogin {
  const { hash, ...fields } = payload;
  if (typeof hash !== "string" || !HASH_RE.test(hash))
    throw new Error("hash missing or malformed");

  const dataCheckString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${k}=${String(fields[k])}`)
    .join("\n");

  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  const got = Buffer.from(hash, "hex");
  if (expected.length !== got.length || !timingSafeEqual(expected, got))
    throw new Error("signature does not match");

  // Everything below is inside the signature, so it is Telegram's own data
  // being range-checked, not user input being sanitised.
  const authDate = Number(payload.auth_date);
  if (!Number.isFinite(authDate)) throw new Error("auth_date missing");
  // Symmetric window: a future-dated auth_date is as much a red flag as a stale
  // one, and the same tolerance covers ordinary clock skew in both directions.
  if (Math.abs(now - authDate * 1000) > MAX_AUTH_AGE_MS)
    throw new Error("auth_date is outside the accepted window");

  const subject = String(payload.id ?? "");
  if (!ID_RE.test(subject)) throw new Error("id missing or not numeric");

  // A Telegram account without a public username has no handle anyone can pay,
  // so there is nothing to link. Charset comes from the registry's own
  // parseTelegram, which also produces the namespaced canonical form: a
  // username this backend accepts and a handle the resolver can look up can
  // never disagree.
  const username = payload.username;
  const handle =
    typeof username === "string" ? getHandleType("telegram")?.parse(username) ?? null : null;
  if (!handle) throw new Error("username missing or not a usable Telegram handle");

  const photo = payload.photo_url;
  const avatarUrl = typeof photo === "string" && photo.startsWith("https://") ? photo : null;

  return { subject, handle, avatarUrl, authDate };
}

/** POST /telegram/link, mounted by resolver.ts.
 *
 *  Takes `rateLimit` as an argument rather than importing it: resolver.ts
 *  imports this module, so importing its limiter back would be a cycle. */
export function telegramRouter(rateLimit: RequestHandler): Router {
  const router = express.Router();

  router.post(
    "/telegram/link",
    requireAuth,
    rateLimit,
    async (req: Request, res: Response): Promise<void> => {
      const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
      if (!botToken) {
        // Fail closed and say so plainly: without the token there is no way to
        // tell a real widget payload from a forged one, so accepting it would
        // let anyone claim any Telegram handle.
        res.status(503).json({
          error: "telegram_unavailable",
          detail: "Telegram linking is not configured on this server.",
        });
        return;
      }

      let verified: VerifiedTelegramLogin;
      try {
        verified = verifyTelegramLogin(req.body as TelegramLoginPayload, botToken);
      } catch (e) {
        res
          .status(400)
          .json({ error: "invalid_telegram_login", detail: (e as Error).message });
        return;
      }

      const userId = (req as Request & { userId?: string }).userId!;
      const ok = await store.upsertTelegramHandle(userId, verified);
      if (!ok) {
        res.status(500).json({ error: "handle_link_failed" });
        return;
      }
      res.json({ ok: true, handle: verified.handle });
    }
  );

  return router;
}
