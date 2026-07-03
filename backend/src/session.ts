// Signed-cookie session.
//
// Cookie payload: base64(JSON({userId, iat}))
// Signature:      base64(HMAC-SHA256(payload, SESSION_SECRET))
// Cookie value:   `${payload}.${signature}`
//
// No DB, no external session store. Rotate by changing SESSION_SECRET.
// Expiry is enforced in-band via `iat + MAX_AGE_MS < now`.

import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const COOKIE_NAME = "bullet_session";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_AGE_S = Math.floor(MAX_AGE_MS / 1000);

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payload: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(payload).digest());
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET must be set to a random string ≥ 16 chars");
  }
  return s;
}

/** Serialize a Set-Cookie header. */
function serializeCookie(value: string, maxAgeS: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeS}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k) out[k] = rest.join("=");
  }
  return out;
}

export function createSession(res: Response, userId: string): void {
  const payload = b64url(Buffer.from(JSON.stringify({ userId, iat: Date.now() })));
  const sig = sign(payload, secret());
  res.setHeader("Set-Cookie", serializeCookie(`${payload}.${sig}`, MAX_AGE_S));
}

export function destroySession(res: Response): void {
  res.setHeader("Set-Cookie", serializeCookie("", 0));
}

/** Parse and verify session cookie. Returns userId or null. */
export function readSession(req: Request): string | null {
  const cookies = parseCookies(req.header("cookie"));
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(sig, sign(payload, secret()))) return null;
  try {
    const { userId, iat } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof userId !== "string" || typeof iat !== "number") return null;
    if (Date.now() - iat > MAX_AGE_MS) return null;
    return userId;
  } catch {
    return null;
  }
}

/** Middleware: attaches req.userId if a valid session cookie is present. */
export function sessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { userId?: string }).userId = readSession(req) ?? undefined;
  next();
}

/** Middleware: requires a valid session. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const uid = readSession(req);
  if (!uid) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  (req as Request & { userId?: string }).userId = uid;
  next();
}
