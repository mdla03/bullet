import { Keypair } from "@stellar/stellar-base";

export function buildChallenge(handle: string, stellarAddress: string): Buffer {
  return Buffer.from(`zeekpay-register-v1:${handle}:${stellarAddress}`, "utf8");
}

export function verifyRegistrationSig(
  handle: string,
  stellarAddress: string,
  sigHex: string
): boolean {
  try {
    const kp = Keypair.fromPublicKey(stellarAddress);
    const challenge = buildChallenge(handle, stellarAddress);
    const sig = Buffer.from(sigHex, "hex");
    return kp.verify(challenge, sig);
  } catch {
    return false;
  }
}
