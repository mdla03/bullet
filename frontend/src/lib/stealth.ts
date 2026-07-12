// Stealth recipientDigest derivation via ECDH.
// Each payment uses a fresh ephemeral X25519 keypair so repeat payments to the
// same handle produce unique recipientDigests and cannot be linked on-chain.

import nacl from "tweetnacl";
import ed2curve from "ed2curve";
import { poseidon } from "./poseidon";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface StealthResult {
  /** Decimal string of the recipientDigest (Poseidon hash of shared secret). */
  recipientDigest: string;
  /** Hex-encoded X25519 ephemeral public key. Stored in note for recipient scanning. */
  ephemeralPubHex: string;
}

/**
 * Derive a per-payment stealth recipientDigest using ECDH.
 *
 * @param recipientBulletPubHex - Recipient's Ed25519 bullet pubkey (64-char hex)
 * @returns unique recipientDigest + ephemeral pubkey
 */
export function deriveStealthDigest(recipientBulletPubHex: string): StealthResult {
  const recipientEd = hexToBytes(recipientBulletPubHex);
  const recipientCurve = ed2curve.convertPublicKey(recipientEd);
  if (!recipientCurve) throw new Error("recipient bullet key not convertible to X25519");

  // Fresh ephemeral X25519 keypair per payment.
  const eph = nacl.box.keyPair();

  // ECDH shared secret (X25519 scalar mult).
  const shared = nacl.scalarMult(eph.secretKey, recipientCurve);

  // Zero the top byte to ensure the value is < BLS12-381 r (~253 bits).
  shared[0] = 0;

  // Convert to decimal bigint for Poseidon.
  const sharedDec = BigInt("0x" + bytesToHex(shared)).toString();

  // recipientDigest = Poseidon([sharedSecret])
  const recipientDigest = poseidon([sharedDec]);

  return {
    recipientDigest,
    ephemeralPubHex: bytesToHex(eph.publicKey),
  };
}
