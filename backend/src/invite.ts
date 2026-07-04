// Invite / pending-payment flow.
//
// Model: sender wants to pay a handle that isn't registered on Bullet yet.
// Backend spins up a per-invite custody wallet, the sender's browser deposits
// to that wallet's digest, and the pending_invites row holds everything needed
// to hand the funds to the real handle-owner when they sign up.
//
// Delivery: when the intended handle-owner links their wallet, backend moves
// any matching pending_invites into their `notes` inbox — the claim_payload
// and custody_secret are encrypted to their bullet_pubkey so only they can
// open them. Their browser then claims as the custody wallet (paying itself)
// and transfers the USDC to their real wallet in one signed Stellar tx.

import * as StellarSdk from "@stellar/stellar-sdk";
import nacl from "tweetnacl";
// @ts-expect-error — ed2curve ships no types.
import ed2curve from "ed2curve";
import { serviceClient } from "./supabase.js";

const HORIZON_URL =
  process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;
const CUSTODY_MASTER_SECRET = process.env.BULLET_CUSTODY_MASTER_SECRET ?? "";
const USDC_SAC = process.env.USDC_SAC_ID ?? "";

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

/** Sealed-box style: eph keypair + nacl.box to recipient's ed25519 pub. */
export function sealTo(recipientPubKeyHex: string, plaintext: string): {
  ephemeral_pubkey: string;
  nonce: string;
  ciphertext: string;
} {
  const curvePub = ed2curve.convertPublicKey(hexToBytes(recipientPubKeyHex));
  if (!curvePub) throw new Error("recipient pubkey not convertible");
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(
    new TextEncoder().encode(plaintext),
    nonce,
    curvePub,
    eph.secretKey
  );
  return {
    ephemeral_pubkey: bytesToHex(eph.publicKey),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ct),
  };
}

function normalizeHandle(q: string): string {
  const t = q.trim();
  return t.startsWith("@") ? "@" + t.slice(1).toLowerCase() : t.toLowerCase();
}

/** Create a new custody Stellar account funded with 1.5 XLM from the master
 * funder. Returns the new keypair. */
export async function createCustodyAccount(): Promise<StellarSdk.Keypair> {
  if (!CUSTODY_MASTER_SECRET) {
    throw new Error(
      "BULLET_CUSTODY_MASTER_SECRET not configured on backend"
    );
  }
  const master = StellarSdk.Keypair.fromSecret(CUSTODY_MASTER_SECRET);
  const custody = StellarSdk.Keypair.random();

  const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
  const masterAcct = await horizon.loadAccount(master.publicKey());

  const tx = new StellarSdk.TransactionBuilder(masterAcct, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.createAccount({
        destination: custody.publicKey(),
        startingBalance: "1.5",
      })
    )
    .addOperation(
      StellarSdk.Operation.changeTrust({
        source: custody.publicKey(),
        asset: usdcAsset(),
      })
    )
    .setTimeout(60)
    .build();
  tx.sign(master);
  tx.sign(custody);
  await horizon.submitTransaction(tx);

  return custody;
}

function usdcAsset(): StellarSdk.Asset {
  // Testnet Circle USDC. Env-overridable via USDC_ASSET_ISSUER for other envs.
  const issuer =
    process.env.USDC_ASSET_ISSUER ??
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const code = process.env.USDC_ASSET_CODE ?? "USDC";
  return new StellarSdk.Asset(code, issuer);
}

void USDC_SAC; // referenced by the browser prover / claim path, not here.

/** Persist a new pending invite once the sender has committed the deposit. */
export async function recordInvite(args: {
  senderUserId: string;
  handle: string;
  denom: 1 | 10 | 50 | 100;
  claimPayload: unknown;
  custody: { publicKey: string; secret: string };
  expiresInDays: 15 | 30;
}): Promise<{ id: string }> {
  const expiresAt = new Date(
    Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await serviceClient
    .from("pending_invites")
    .insert({
      sender_user_id: args.senderUserId,
      handle_normalized: normalizeHandle(args.handle),
      denom: args.denom,
      claim_payload: args.claimPayload,
      custody_stellar_address: args.custody.publicKey,
      custody_secret: args.custody.secret,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id };
}

/** Called after a user links a wallet: move any pending invites that were
 * addressed to any of their handles into their notes inbox, encrypted to their
 * bullet pubkey. Idempotent. Silent-fail per-row to not block the linking. */
export async function deliverInvitesFor(
  userId: string,
  bulletPubKeyHex: string
): Promise<{ delivered: number }> {
  const { data: handles, error: hErr } = await serviceClient
    .from("handles")
    .select("handle_normalized")
    .eq("user_id", userId);
  if (hErr) return { delivered: 0 };
  const handleSet = (handles ?? []).map((h) => h.handle_normalized);
  if (handleSet.length === 0) return { delivered: 0 };

  const { data: invites, error: iErr } = await serviceClient
    .from("pending_invites")
    .select("id, claim_payload, custody_secret")
    .in("handle_normalized", handleSet)
    .is("delivered_at", null)
    .is("claimed_at", null)
    .is("refunded_at", null);
  if (iErr || !invites) return { delivered: 0 };

  let delivered = 0;
  for (const inv of invites) {
    try {
      const payloadSealed = sealTo(
        bulletPubKeyHex,
        JSON.stringify(inv.claim_payload)
      );
      const custodySealed = sealTo(bulletPubKeyHex, inv.custody_secret);
      const { error: nErr } = await serviceClient.from("notes").insert({
        recipient_pubkey: bulletPubKeyHex,
        ephemeral_pubkey: payloadSealed.ephemeral_pubkey,
        nonce: payloadSealed.nonce,
        ciphertext: payloadSealed.ciphertext,
        invite_id: inv.id,
        custody_secret: JSON.stringify(custodySealed),
      });
      if (nErr) continue;
      await serviceClient
        .from("pending_invites")
        .update({ delivered_at: new Date().toISOString() })
        .eq("id", inv.id);
      delivered += 1;
    } catch {
      // continue — one bad invite shouldn't block the rest.
    }
  }
  return { delivered };
}

/** Sender's dashboard: their sent invites, newest first. */
export async function listInvitesForSender(senderUserId: string): Promise<
  Array<{
    id: string;
    handle: string;
    denom: number;
    expires_at: string;
    delivered_at: string | null;
    claimed_at: string | null;
    refunded_at: string | null;
    created_at: string;
  }>
> {
  const { data, error } = await serviceClient
    .from("pending_invites")
    .select(
      "id, handle_normalized, denom, expires_at, delivered_at, claimed_at, refunded_at, created_at"
    )
    .eq("sender_user_id", senderUserId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []).map((r) => ({
    id: r.id,
    handle: r.handle_normalized,
    denom: r.denom,
    expires_at: r.expires_at,
    delivered_at: r.delivered_at,
    claimed_at: r.claimed_at,
    refunded_at: r.refunded_at,
    created_at: r.created_at,
  }));
}
