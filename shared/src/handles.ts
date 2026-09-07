// Pluggable handle-type registry (D3).
//
// A "handle" is anything a payer can type into Send to reach a recipient: an
// X handle, an email, a GitHub username, etc. Each type here owns its own
// parsing/formatting and states how its owner proves control of it before a
// public key is ever published for it (SPEC §7: proof-of-control precedes
// key publication).
//
// Consumed by both @zeekpay/backend (resolver ownership checks) and
// @bullet/frontend (register/account UI), keep this dependency-free.

/** How a handle type's owner proves control before a key is published. */
export type HandleProof =
  | { type: "supabase-oauth"; provider: string }
  | { type: "telegram-widget" }
  | { type: "email-otp" };

export type HandleTypeId =
  | "x"
  | "email"
  | "google"
  | "github"
  | "discord"
  | "telegram";

export interface HandleType {
  id: HandleTypeId;
  label: string;
  /** false hides the type from every UI surface (sign-in buttons, account
   *  "connect" list, send-type affordances). */
  enabled: boolean;
  proof: HandleProof;
  /** Raw values Supabase's auth.identities.provider column has used for this
   *  type. Usually just [proof.provider], but X shipped under a few ids. */
  identityProviders: string[];
  /** Input the user typed/picked -> canonical stored form, or null if invalid. */
  parse(input: string): string | null;
  /** Canonical form -> how it's displayed. */
  format(canonical: string): string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailLike(input: string): string | null {
  const t = input.trim().toLowerCase();
  return EMAIL_RE.test(t) ? t : null;
}

function parseX(input: string): string | null {
  const body = input.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(body)) return null;
  return "@" + body.toLowerCase();
}

function parseGithub(input: string): string | null {
  const body = input.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(body)) return null;
  return body.toLowerCase();
}

function parseDiscord(input: string): string | null {
  const body = input.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{2,32}$/.test(body)) return null;
  return body;
}

function parseTelegram(input: string): string | null {
  const body = input.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(body)) return null;
  return body.toLowerCase();
}

const identity = (c: string) => c;

export const HANDLE_TYPES: readonly HandleType[] = [
  {
    id: "google",
    label: "Google",
    enabled: true,
    proof: { type: "supabase-oauth", provider: "google" },
    identityProviders: ["google"],
    parse: parseEmailLike,
    format: identity,
  },
  {
    id: "x",
    label: "X",
    enabled: true,
    proof: { type: "supabase-oauth", provider: "x" },
    // X has shipped under a few provider ids historically; match them all.
    identityProviders: ["x", "twitter", "twitter_v2"],
    parse: parseX,
    format: identity,
  },
  {
    id: "email",
    label: "Email",
    enabled: true,
    proof: { type: "email-otp" },
    identityProviders: ["email"],
    parse: parseEmailLike,
    format: identity,
  },
  {
    id: "github",
    label: "GitHub",
    enabled: true,
    proof: { type: "supabase-oauth", provider: "github" },
    identityProviders: ["github"],
    parse: parseGithub,
    format: (c) => "@" + c,
  },
  {
    id: "discord",
    label: "Discord",
    enabled: false,
    proof: { type: "supabase-oauth", provider: "discord" },
    identityProviders: ["discord"],
    parse: parseDiscord,
    format: identity,
  },
  {
    id: "telegram",
    label: "Telegram",
    enabled: false,
    proof: { type: "telegram-widget" },
    identityProviders: ["telegram"],
    parse: parseTelegram,
    format: (c) => "@" + c,
  },
];

export function getHandleType(id: string): HandleType | undefined {
  return HANDLE_TYPES.find((h) => h.id === id);
}

export function enabledHandleTypes(): HandleType[] {
  return HANDLE_TYPES.filter((h) => h.enabled);
}

/** Handle type whose identityProviders includes a raw Supabase
 *  auth.identities.provider value, e.g. "twitter_v2" or "github". */
export function handleTypeForIdentityProvider(provider: string): HandleType | undefined {
  return HANDLE_TYPES.find((h) => h.identityProviders.includes(provider));
}

export interface OwnershipCheck {
  ok: boolean;
  error?:
    | "unknown_handle_type"
    | "handle_type_disabled"
    | "not_oauth_backed"
    | "provider_mismatch";
}

/**
 * True iff one of the caller's already-verified Supabase identity providers
 * proves control of `handleTypeId`. Pure: callers fetch `identityProviders`
 * from a verified JWT/session (never from user input) before calling this.
 */
export function verifyHandleTypeOwnership(
  handleTypeId: string,
  identityProviders: string[]
): OwnershipCheck {
  const handleType = getHandleType(handleTypeId);
  if (!handleType) return { ok: false, error: "unknown_handle_type" };
  if (!handleType.enabled) return { ok: false, error: "handle_type_disabled" };
  if (handleType.proof.type !== "supabase-oauth")
    return { ok: false, error: "not_oauth_backed" };
  const owns = identityProviders.some((p) => handleType.identityProviders.includes(p));
  return owns ? { ok: true } : { ok: false, error: "provider_mismatch" };
}
