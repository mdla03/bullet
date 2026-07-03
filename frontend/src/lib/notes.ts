// Encrypted note registry (Supabase `notes` table).
//
// The sender's browser sealed-box-encrypts the claim payload to the
// recipient's registered Bullet pubkey (Ed25519, converted to X25519).
// Only the recipient, re-deriving their key from the same Freighter
// signature, can decrypt. Rows are public ciphertext; the money itself
// is protected by the on-chain nullifier, not by this table.

import nacl from "tweetnacl";
import ed2curve from "ed2curve";
import { supabase } from "./supabase";
import type { ClaimPayload } from "./claim_link";

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

export interface BulletKeys {
  /** Ed25519 public key (hex); equals the registered zeekPayPubKey. */
  pubKeyHex: string;
  /** X25519 secret key for opening sealed notes. */
  curveSecret: Uint8Array;
}

/** Re-derive Bullet keys from the Freighter signature over KEY_DOMAIN_MESSAGE. */
export function deriveBulletKeys(domainSigHex: string): BulletKeys {
  const seed = hexToBytes(domainSigHex).slice(0, 32);
  const sign = nacl.sign.keyPair.fromSeed(seed);
  return {
    pubKeyHex: bytesToHex(sign.publicKey),
    curveSecret: ed2curve.convertSecretKey(sign.secretKey),
  };
}

export interface InboxNote {
  id: string;
  payload: ClaimPayload;
  createdAt: string;
  claimedAt: string | null;
}

/** Encrypt a claim payload to the recipient's Bullet pubkey and store it. */
export async function postNote(
  payload: ClaimPayload,
  recipientPubKeyHex: string
): Promise<void> {
  const curvePub = ed2curve.convertPublicKey(hexToBytes(recipientPubKeyHex));
  if (!curvePub) throw new Error("recipient Bullet key is not convertible");
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    new TextEncoder().encode(JSON.stringify(payload)),
    nonce,
    curvePub,
    eph.secretKey
  );
  const { error } = await supabase.from("notes").insert({
    recipient_pubkey: recipientPubKeyHex,
    ephemeral_pubkey: bytesToHex(eph.publicKey),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ciphertext),
  });
  if (error) throw new Error(`inbox delivery failed: ${error.message}`);
}

/** Fetch and decrypt every note addressed to these keys, newest first. */
export async function fetchNotes(keys: BulletKeys): Promise<InboxNote[]> {
  const { data, error } = await supabase
    .from("notes")
    .select("id, ephemeral_pubkey, nonce, ciphertext, created_at, claimed_at")
    .eq("recipient_pubkey", keys.pubKeyHex)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`inbox scan failed: ${error.message}`);

  const notes: InboxNote[] = [];
  for (const row of data ?? []) {
    const opened = nacl.box.open(
      hexToBytes(row.ciphertext),
      hexToBytes(row.nonce),
      hexToBytes(row.ephemeral_pubkey),
      keys.curveSecret
    );
    if (!opened) continue; // wrong key or corrupted row: skip silently
    try {
      notes.push({
        id: row.id,
        payload: JSON.parse(new TextDecoder().decode(opened)) as ClaimPayload,
        createdAt: row.created_at,
        claimedAt: row.claimed_at,
      });
    } catch {
      // not JSON: skip
    }
  }
  return notes;
}

/** Stamp a note claimed so it renders as history instead of claimable. */
export async function markClaimed(id: string): Promise<void> {
  await supabase
    .from("notes")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", id);
}
