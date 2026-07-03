import { Keypair, hash } from "@stellar/stellar-base";

/** SEP-53 domain-separation prefix Freighter prepends before hashing/signing. */
const SEP53_PREFIX = Buffer.from("Stellar Signed Message:\n", "utf8");

/** Challenge signed by the user's Stellar keypair (via Freighter) to prove wallet ownership. */
export function buildLinkWalletChallenge(userId: string): Buffer {
  return Buffer.from(`bullet-link-wallet-v1:${userId}`, "utf8");
}

/**
 * SEP-53 message digest: SHA-256(prefix ‖ message). Freighter's signMessage
 * signs this digest, not the raw challenge bytes, so verification must match.
 */
function sep53Digest(message: Buffer): Buffer {
  const payload = new Uint8Array(SEP53_PREFIX.length + message.length);
  payload.set(SEP53_PREFIX, 0);
  payload.set(message, SEP53_PREFIX.length);
  return hash(Buffer.from(payload));
}

export function verifyLinkWalletSig(
  userId: string,
  stellarAddress: string,
  sigHex: string
): boolean {
  try {
    const kp = Keypair.fromPublicKey(stellarAddress);
    const digest = sep53Digest(buildLinkWalletChallenge(userId));
    const sig = Buffer.from(sigHex, "hex");
    return kp.verify(digest, sig);
  } catch {
    return false;
  }
}
