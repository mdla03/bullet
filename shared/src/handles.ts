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

/** Supabase auth provider ids this registry proves handles with. A local
 *  string-literal union rather than @supabase/supabase-js's `Provider`, to keep
 *  this file dependency-free. Every member is also a member of that `Provider`
 *  union, so frontend code can pass one straight into signInWithOAuth /
 *  linkIdentity without a cast. */
export type OAuthProviderId = "google" | "x" | "github" | "discord";

/** How a handle type's owner proves control before a key is published. */
export type HandleProof =
  | { type: "supabase-oauth"; provider: OAuthProviderId }
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
  /** Input the user typed/picked -> canonical stored form, or null if invalid.
   *
   *  CANONICAL FORMS ARE GLOBALLY UNIQUE across every type here, because
   *  public.handles keys the resolver on a single handle_normalized column with
   *  one unique index over it (backend/sql/handles_unique.sql). Two types may
   *  only share a canonical form when they genuinely mean the same person at
   *  the same address, which is why google and email both canonicalize to the
   *  bare email: one person, one address, one row.
   *
   *  Types whose handle is a bare name therefore carry a "<type>:" namespace,
   *  so a GitHub "alice" and a Discord "alice" are different keys. X keeps its
   *  "@name" form: the leading "@" is the namespace, and no other type here
   *  produces one. */
  parse(input: string): string | null;
  /** Canonical form -> how it's displayed. Strips the namespace: the UI already
   *  renders the type's icon and label beside the value, so "github:torvalds"
   *  shows as "torvalds". */
  format(canonical: string): string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Strips a leading "<ns>:" and, when `stripAt` is set, a leading "@" too.
 *  parse() call sites pass stripAt so a canonical form fed back through
 *  parse() round-trips and a user pasting either shape is accepted; format()
 *  call sites leave it unset since a canonical form never carries an "@"
 *  before this strips the namespace. */
function unnamespace(input: string, ns: string, stripAt = false): string {
  const t = input.trim();
  const prefix = ns + ":";
  const body = t.toLowerCase().startsWith(prefix) ? t.slice(prefix.length) : t;
  return stripAt ? body.replace(/^@/, "") : body;
}

/** Builds a namespaced canonical form. The inverse of unnamespace(). */
function namespace(type: string, body: string): string {
  return type + ":" + body.toLowerCase();
}

function parseEmailLike(input: string): string | null {
  const t = input.trim().toLowerCase();
  return EMAIL_RE.test(t) ? t : null;
}

function parseX(input: string): string | null {
  const body = input.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(body)) return null;
  return "@" + body.toLowerCase();
}

// The three bare-name types. Their canonical form is namespaced; the charset
// rule below each one is mirrored by a guard in the SQL trigger
// (backend/sql/handles_github.sql) so a value the trigger writes and a value
// this file parses can never disagree.
function parseGithub(input: string): string | null {
  const body = unnamespace(input, "github", true);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(body)) return null;
  return namespace("github", body);
}

function parseDiscord(input: string): string | null {
  const body = unnamespace(input, "discord", true).toLowerCase();
  if (!/^[a-z0-9._]{2,32}$/.test(body)) return null;
  return namespace("discord", body);
}

function parseTelegram(input: string): string | null {
  const body = unnamespace(input, "telegram", true);
  if (!/^[A-Za-z0-9_]{5,32}$/.test(body)) return null;
  return namespace("telegram", body);
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
    // Bare login, no "@": GitHub logins are not "@handles" and the UI puts the
    // GitHub icon and label next to the value already.
    format: (c) => unnamespace(c, "github"),
  },
  {
    id: "discord",
    label: "Discord",
    enabled: false,
    proof: { type: "supabase-oauth", provider: "discord" },
    identityProviders: ["discord"],
    parse: parseDiscord,
    format: (c) => unnamespace(c, "discord"),
  },
  {
    id: "telegram",
    label: "Telegram",
    enabled: false,
    proof: { type: "telegram-widget" },
    identityProviders: ["telegram"],
    parse: parseTelegram,
    format: (c) => "@" + unnamespace(c, "telegram"),
  },
];

/** Throws if two types in `types` share a raw identityProviders value.
 *  handleTypeForIdentityProvider() below finds the first type whose
 *  identityProviders includes a given raw provider id; if two types claimed
 *  the same raw id, that lookup would silently route one type's identities
 *  to the other type's row instead of raising anything. Exported (rather than
 *  only run at module load) so a test can call it against a deliberately
 *  overlapping registry and assert it throws. */
export function assertDisjointIdentityProviders(
  types: readonly { id: string; identityProviders: string[] }[]
): void {
  const owner = new Map<string, string>();
  for (const t of types) {
    for (const p of t.identityProviders) {
      const existing = owner.get(p);
      if (existing !== undefined) {
        throw new Error(
          `handle registry: identityProviders value "${p}" is claimed by both ` +
            `"${existing}" and "${t.id}"; identityProviders must be pairwise ` +
            `disjoint across handle types`
        );
      }
      owner.set(p, t.id);
    }
  }
}

assertDisjointIdentityProviders(HANDLE_TYPES);

export function getHandleType(id: string): HandleType | undefined {
  return HANDLE_TYPES.find((h) => h.id === id);
}

export function enabledHandleTypes(): HandleType[] {
  return HANDLE_TYPES.filter((h) => h.enabled);
}

/** Narrows an untrusted string (a URL query param, a Supabase error hint) to an
 *  OAuth provider id of an enabled type, or undefined. Callers use this instead
 *  of comparing against a hardcoded provider list, so enabling a type here is
 *  the only edit needed. */
export function asOAuthProviderId(
  value: string | null | undefined
): OAuthProviderId | undefined {
  for (const h of enabledHandleTypes()) {
    if (h.proof.type === "supabase-oauth" && h.proof.provider === value) {
      return h.proof.provider;
    }
  }
  return undefined;
}

/** The enabled handle type that owns a canonical form, i.e. the one whose
 *  parse() returns that exact string back. Canonical forms are namespaced to
 *  be globally unique (see the parse() contract above), so "github:alice"
 *  finds GitHub and "@alice" finds X.
 *
 *  Google and email are the deliberate exception: both canonicalize a bare
 *  email to itself, because they mean the same person at the same address.
 *  Registry order decides, and either label is truthful for that row.
 *
 *  Used to label a stored handle when only the canonical string is at hand
 *  (the resolver's ambiguity response), never to decide which row a typed
 *  query meant: parse() would happily turn a bare "alice" into "github:alice",
 *  which is exactly the ambiguity the caller is trying to report. */
export function handleTypeForCanonical(canonical: string): HandleType | undefined {
  return enabledHandleTypes().find((t) => t.parse(canonical) === canonical);
}

/** Handle type whose identityProviders includes a raw Supabase
 *  auth.identities.provider value, e.g. "twitter_v2" or "github". */
export function handleTypeForIdentityProvider(provider: string): HandleType | undefined {
  return HANDLE_TYPES.find((h) => h.identityProviders.includes(provider));
}
