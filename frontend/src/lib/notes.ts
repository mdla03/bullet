// Encrypted note registry (Supabase `notes` table).
//
// The sender's browser sealed-box-encrypts the claim payload to the
// recipient's registered Bullet pubkey (Ed25519, converted to X25519).
// Only the recipient, re-deriving their key from the same Freighter
// signature, can decrypt. Rows are public ciphertext; the money itself
// is protected by the on-chain nullifier, not by this table.

import nacl from "tweetnacl";
import ed2curve from "ed2curve";
import { createClient } from "./supabase/client";
import type { ClaimPayload } from "./claim_link";

const supabase = createClient();

const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";

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
  /** Present when this note came from an invite. Decrypted custody wallet
   * Stellar secret (S…); the recipient uses it to sign the claim+forward tx. */
  custodyStellarSecret?: string;
  inviteId?: string;
}

/** Encrypt a claim payload to the recipient's Bullet pubkey and store it.
 *  Goes through the backend (M4): notes INSERT is RLS-locked to the service
 *  role, so a browser can't spam arbitrary inboxes with direct inserts. */
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
  const res = await fetch(`${RESOLVER_URL}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipientPubkey: recipientPubKeyHex,
      ephemeralPubkey: bytesToHex(eph.publicKey),
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext),
    }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`inbox delivery failed: ${err.error ?? res.status}`);
  }
}

/** Fetch and decrypt every note addressed to these keys, newest first. */
export async function fetchNotes(keys: BulletKeys): Promise<InboxNote[]> {
  const { data, error } = await supabase
    .from("notes")
    .select(
      "id, ephemeral_pubkey, nonce, ciphertext, created_at, claimed_at, invite_id, custody_secret"
    )
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
      let custodyStellarSecret: string | undefined;
      if (row.invite_id && row.custody_secret) {
        try {
          const sealed = JSON.parse(row.custody_secret) as {
            ephemeral_pubkey: string;
            nonce: string;
            ciphertext: string;
          };
          const custOpen = nacl.box.open(
            hexToBytes(sealed.ciphertext),
            hexToBytes(sealed.nonce),
            hexToBytes(sealed.ephemeral_pubkey),
            keys.curveSecret
          );
          if (custOpen) {
            custodyStellarSecret = new TextDecoder().decode(custOpen);
          }
        } catch {
          // custody blob unreadable: leave undefined so the row shows but can't be claimed
        }
      }
      notes.push({
        id: row.id,
        payload: JSON.parse(new TextDecoder().decode(opened)) as ClaimPayload,
        createdAt: row.created_at,
        claimedAt: row.claimed_at,
        inviteId: row.invite_id ?? undefined,
        custodyStellarSecret,
      });
    } catch {
      // not JSON: skip
    }
  }
  return notes;
}

/** Stamp a note claimed so it renders as history instead of claimable.
 * Goes through the backend since notes.UPDATE is RLS-locked to service_role. */
export async function markClaimed(id: string): Promise<void> {
  const { apiFetch } = await import("./api");
  try {
    await apiFetch("/notes/mark-claimed", {
      method: "POST",
      body: JSON.stringify({ noteId: id }),
    });
  } catch {
    // Best-effort. The on-chain nullifier is the real record.
  }
}
