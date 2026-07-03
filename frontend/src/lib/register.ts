import { Keypair } from "@stellar/stellar-base";

/** Domain-separated message whose signature seeds the Bullet keypair (SPEC §7). */
export const KEY_DOMAIN_MESSAGE = "zeekpay-key-v1";

/** Challenge the backend verifies in POST /wallet/link. */
export function buildLinkWalletChallenge(userId: string): string {
  return `bullet-link-wallet-v1:${userId}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Freighter signMessage returns Buffer (v3) or base64 string (v4). Normalize to hex. */
export function signatureToHex(signed: Uint8Array | string): string {
  if (typeof signed === "string") {
    const bin = atob(signed);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytesToHex(bytes);
  }
  return bytesToHex(new Uint8Array(signed));
}

/**
 * Bullet keys: first 32 bytes of the Ed25519 signature over KEY_DOMAIN_MESSAGE
 * become the seed; the registered zeekPayPubKey is the derived public key (hex).
 */
export function deriveBulletPubKey(domainSigHex: string): string {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    seed[i] = parseInt(domainSigHex.slice(i * 2, i * 2 + 2), 16);
  }
  // stellar-base's tweetnacl backend accepts any Uint8Array seed at runtime.
  const kp = Keypair.fromRawEd25519Seed(seed as unknown as Buffer);
  return bytesToHex(new Uint8Array(kp.rawPublicKey()));
}
