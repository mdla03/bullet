import { xdr, StrKey } from "@stellar/stellar-base";

/** Compute recipientDigest = sha256(ScVal(Address) XDR) with top byte zeroed.
 * Must match the contract's derivation, which calls Address::to_xdr(env). In
 * soroban-sdk that serializes the Address as ScVal::Address, so we wrap the
 * ScAddress in an ScVal here — the 4-byte `0000 0012` discriminator prefix
 * matters (it's why the 40-byte raw form gave a different digest and rejected
 * every proof). */
export async function computeRecipientDigest(stellarAddress: string): Promise<bigint> {
  const raw = StrKey.decodeEd25519PublicKey(stellarAddress);
  const acctId = xdr.PublicKey.publicKeyTypeEd25519(raw);
  const scAddr = xdr.ScAddress.scAddressTypeAccount(acctId);
  const scVal = xdr.ScVal.scvAddress(scAddr);
  const xdrBytes = scVal.toXDR();

  const hashBuf = await crypto.subtle.digest("SHA-256", new Uint8Array(xdrBytes));
  const bytes = new Uint8Array(hashBuf);
  bytes[0] = 0;

  return BigInt(
    "0x" +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
  );
}
