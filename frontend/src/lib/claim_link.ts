export interface ClaimPayload {
  secret: string;           // hex, 64 chars (32 bytes)
  recipientDigest: string;  // decimal bigint string
  denom: 1 | 10 | 50 | 100;
  // Context fields below are OPTIONAL: they are kept in the encrypted inbox
  // note but omitted from the URL link to keep it short. The claim page falls
  // back to env (contract id) / defaults (network) when they are absent.
  contractId?: string;
  network?: "testnet";
  /** Handle the sender addressed (e.g. "@elykable", "you@x.com"). Shown in the
   * inbox; not carried in the link. */
  recipientHandle?: string;
}

/** Only these three fields travel in the URL. Everything else is a known
 * constant (contract id, network) or cosmetic (handle), recovered on the claim
 * page — so the link stays short. The secret still lives ONLY in the link,
 * never server-side. */
function b64urlEncode(obj: unknown): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function encodeClaimLink(
  payload: ClaimPayload,
  frontendUrl: string
): string {
  const link = {
    secret: payload.secret,
    recipientDigest: payload.recipientDigest,
    denom: payload.denom,
  };
  return `${frontendUrl}/c?p=${b64urlEncode(link)}`;
}

export function decodeClaimLink(link: string): ClaimPayload | null {
  try {
    const url = new URL(link);
    const encoded = url.searchParams.get("p");
    if (!encoded) return null;
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
    return JSON.parse(json) as ClaimPayload;
  } catch {
    return null;
  }
}
