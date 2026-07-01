export interface ClaimPayload {
  secret: string;           // hex, 64 chars (32 bytes)
  recipientDigest: string;  // decimal bigint string
  denom: 1 | 10 | 50 | 100;
  contractId: string;
  network: "testnet";
}

export function encodeClaimLink(
  payload: ClaimPayload,
  frontendUrl: string
): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${frontendUrl}/claim?p=${encoded}`;
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
