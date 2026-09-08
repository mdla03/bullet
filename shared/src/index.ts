// Shared types between @zeekpay/backend and @zeekpay/frontend.

export * from "./handles.js";

export interface ResolveResult {
  found: boolean;
  stellarAddress?: string;
  /** hex-encoded 32-byte X25519 public key (format locked in x-oauth-identity) */
  zeekPayPubKey?: string;
  contractAddress?: string;
  usdcSac?: string;
  /** Set (with an HTTP 300 status) when the query's candidate canonical forms
   *  matched more than one person, e.g. a bare "alice" matching both an X and
   *  a GitHub user. The canonical handles that matched, for a disambiguation
   *  prompt; found is always false alongside this. */
  candidates?: string[];
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
