import { Keypair } from "@stellar/stellar-base";

/** Challenge signed by the user's Stellar keypair (via Freighter) to prove wallet ownership. */
export function buildLinkWalletChallenge(userId: string): Buffer {
  return Buffer.from(`bullet-link-wallet-v1:${userId}`, "utf8");
}

export function verifyLinkWalletSig(
  userId: string,
  stellarAddress: string,
  sigHex: string
): boolean {
  try {
    const kp = Keypair.fromPublicKey(stellarAddress);
    const challenge = buildLinkWalletChallenge(userId);
    const sig = Buffer.from(sigHex, "hex");
    return kp.verify(challenge, sig);
  } catch {
    return false;
  }
}
