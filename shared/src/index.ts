// Shared types between @zeekpay/backend and @zeekpay/frontend.

// Self-reference through the package's own name (not a relative import), so
// this goes through the `exports` map in package.json under both bundlers:
// see the note there and in frontend/next.config.ts's webpack config.
export * from "@zeekpay/shared/handles.js";
import type { HandleTypeId } from "@zeekpay/shared/handles.js";

/** One option in a /resolve disambiguation prompt (HTTP 300). Carries the
 *  registry metadata the client needs to render a label-only choice, so no
 *  screen has to re-derive a handle type from a canonical string. */
export interface ResolveCandidate {
  /** HandleTypeId of the registry type that owns this canonical form
   *  ("github", "x", …). Also a valid identityProviders value for that type,
   *  so it can be passed straight to the frontend's displayHandle(). */
  type: string;
  /** That type's registry label, e.g. "GitHub". */
  label: string;
  /** The canonical stored form, e.g. "github:alice". Sending this back to
   *  /resolve resolves unambiguously. */
  handle: string;
  /** Provider profile photo, https only (backend/sql/handles_avatar.sql).
   *  null when the provider has none on file or the row predates that
   *  migration and the backfill has not reached it; undefined is not
   *  distinguished from null on the wire. */
  avatarUrl?: string | null;
  /** Public profile page for this candidate, e.g. "https://github.com/alice",
   *  so the sender can verify who they are picking before sending. null when
   *  the type has no public profile URL (google, email, discord). */
  profileUrl?: string | null;
}

export interface ResolveResult {
  found: boolean;
  stellarAddress?: string;
  /** hex-encoded 32-byte X25519 public key (format locked in x-oauth-identity) */
  zeekPayPubKey?: string;
  contractAddress?: string;
  usdcSac?: string;
  /** HandleTypeId of the registry type that resolved, e.g. "github". Set
   *  alongside a successful (found:true) result. */
  type?: HandleTypeId;
  /** Provider profile photo, https only. See ResolveCandidate.avatarUrl for
   *  what null vs. omitted means; also set for an unregistered GitHub handle
   *  (found:false, 404) so the invite screen can still show a face. */
  avatarUrl?: string | null;
  /** Public profile page for the resolved (or, for an unregistered GitHub
   *  handle, the queried) person. See ResolveCandidate.profileUrl. */
  profileUrl?: string | null;
  /** Set (with an HTTP 300 status) when the query's candidate canonical forms
   *  matched more than one person, e.g. a bare "alice" matching both an X and
   *  a GitHub user. The handles that matched, for a disambiguation prompt;
   *  found is always false alongside this. */
  candidates?: ResolveCandidate[];
}

export interface RegisterRequest {
  /** X handle e.g. "@alice" — at least one of handle/email required */
  handle?: string;
  email?: string;
  stellarAddress: string;
  /** hex-encoded 32-byte X25519 public key */
  zeekPayPubKey: string;
  /** Freighter signature proving key ownership (verified in x-oauth-identity) */
  signature: string;
}
