// Shared types between @zeekpay/backend and @zeekpay/frontend.

export interface ResolveResult {
  found: boolean;
  stellarAddress?: string;
  /** hex-encoded 32-byte X25519 public key (format locked in x-oauth-identity) */
  zeekPayPubKey?: string;
  contractAddress?: string;
  usdcSac?: string;
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
