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
import { requireAuth, serviceClient } from "./supabase.js";
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

/**
 * Address for a Telegram account that has no email of its own.
 *
 * Telegram never gives us one, and Supabase keys users by email, so a
 * Telegram-only signup needs a placeholder. `.invalid` is reserved by RFC 2606
 * and guaranteed never to resolve, so nothing addressed here can leave the
 * building even if some future code path tries to send to it. Derived from the
 * numeric id so it is stable: the same Telegram account always maps to the
 * same row, and a username change does not strand an account.
 */
export function syntheticEmail(subject: string): string {
  return `telegram-${subject}@telegram.invalid`;
}

/** A user who can be signed in, plus whether this call is what created them. */
interface ResolvedUser {
  userId: string;
  email: string;
  created: boolean;
}

/**
 * The Supabase user behind a verified Telegram login, creating one on first
 * sight.
 *
 * Lookup is by Telegram's numeric id via the handles row, never by username:
 * usernames are released and re-registered, and the id is what the signature
 * binds. A username that changed hands therefore cannot reach the previous
 * owner's account.
 */
async function resolveUser(verified: VerifiedTelegramLogin): Promise<ResolvedUser> {
  const existing = await store.findUserByTelegramSubject(verified.subject);
  if (existing) {
    const { data, error } = await serviceClient.auth.admin.getUserById(existing);
    if (error || !data.user?.email) {
      throw new Error("could not read the account this Telegram is linked to");
    }
    return { userId: existing, email: data.user.email, created: false };
  }

  const email = syntheticEmail(verified.subject);
  const { data, error } = await serviceClient.auth.admin.createUser({
    email,
    // Nothing can ever be delivered to a .invalid address, so there is no
    // confirmation to wait for. Telegram's signature is the proof here.
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(error?.message ?? "could not create an account");
  }
  return { userId: data.user.id, email, created: true };
}

/** POST /telegram/link and /telegram/signin, mounted by resolver.ts.
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

  // Sign in (or sign up) with Telegram. Unauthenticated by necessity: it is
  // what produces a session. The only thing standing between a caller and a
  // session is verifyTelegramLogin, so nothing below runs until the payload's
  // HMAC checks out against the bot token and its auth_date is inside the
  // ten-minute window.
  router.post(
    "/telegram/signin",
    rateLimit,
    async (req: Request, res: Response): Promise<void> => {
      const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
      if (!botToken) {
        res.status(503).json({
          error: "telegram_unavailable",
          detail: "Telegram sign-in is not configured on this server.",
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

      let user: ResolvedUser;
      try {
        user = await resolveUser(verified);
      } catch (e) {
        console.error("[telegram] signin could not resolve a user:", (e as Error).message);
        res.status(500).json({ error: "signin_failed", detail: (e as Error).message });
        return;
      }

      // Write the handle on every sign-in, not just the first: a username that
      // changed on Telegram's side would otherwise leave this account payable
      // at a name its owner no longer holds.
      if (!(await store.upsertTelegramHandle(user.userId, verified))) {
        res.status(500).json({ error: "handle_link_failed" });
        return;
      }

      // generateLink mints the token without sending any mail, which is the
      // point: the address may be a .invalid placeholder that can never
      // receive one. The browser exchanges this for a session via verifyOtp.
      const { data, error } = await serviceClient.auth.admin.generateLink({
        type: "magiclink",
        email: user.email,
      });
      const tokenHash = data?.properties?.hashed_token;
      if (error || !tokenHash) {
        console.error("[telegram] generateLink failed:", error?.message);
        res.status(500).json({ error: "signin_failed" });
        return;
      }

      res.json({ token_hash: tokenHash, created: user.created, handle: verified.handle });
    }
  );

  return router;
}
