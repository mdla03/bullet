import { xdr, StrKey } from "@stellar/stellar-base";

/** Compute recipientDigest = sha256(ScAddress XDR) with top byte zeroed. */
export async function computeRecipientDigest(stellarAddress: string): Promise<bigint> {
  const raw = StrKey.decodeEd25519PublicKey(stellarAddress);
  // ScAddress::Account XDR (40 bytes):
  //   00000000  SC_ADDRESS_TYPE_ACCOUNT
  //   00000000  PUBLIC_KEY_TYPE_ED25519
  //   <32 bytes> Ed25519 key
  const acctId = xdr.PublicKey.publicKeyTypeEd25519(raw);
  const scAddr = xdr.ScAddress.scAddressTypeAccount(acctId);
  const xdrBytes = scAddr.toXDR();

  const hashBuf = await crypto.subtle.digest("SHA-256", new Uint8Array(xdrBytes));
  const bytes = new Uint8Array(hashBuf);
  bytes[0] = 0; // zero top byte so result < BLS12-381 r (~255 bits)

  return BigInt(
    "0x" +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
  );
}
