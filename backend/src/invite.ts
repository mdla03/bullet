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
import { poseidon } from "./poseidon.js";
import { RPC_URL, CONTRACT_ID, ADMIN_KEY } from "./chain_config.js";
import { decimalToHex32, simulateBoolView } from "./chain_view.js";

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

// ── custody secret encryption at rest (H3) ────────────────────────────────────
// The custody wallet's Stellar secret controls real USDC held for an unclaimed
// invite. Storing it plaintext means a DB or service-role-key compromise sweeps
// every custody wallet. Encrypt it with a backend-only key (nacl.secretbox)
// before it touches Postgres. Fail closed: if the key is missing we refuse to
// write rather than silently persisting plaintext.
const CUSTODY_ENC_PREFIX = "enc:v1:";

function custodyEncKey(): Uint8Array {
  const raw = process.env.BULLET_CUSTODY_ENC_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "BULLET_CUSTODY_ENC_KEY must be 64 hex chars (32 bytes); refusing to store custody secret in plaintext"
    );
  }
  return hexToBytes(raw);
}

/** Encrypt a custody secret for storage. Output: enc:v1:<nonceHex>:<ctHex>. */
export function encryptCustodySecret(plaintext: string): string {
  const key = custodyEncKey();
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(new TextEncoder().encode(plaintext), nonce, key);
  return `${CUSTODY_ENC_PREFIX}${bytesToHex(nonce)}:${bytesToHex(ct)}`;
}

/** Decrypt a stored custody secret. Legacy plaintext rows (no prefix) are
 *  returned as-is for backward compatibility during migration. */
export function decryptCustodySecret(stored: string): string {
  if (!stored.startsWith(CUSTODY_ENC_PREFIX)) {
    console.warn("[invite] custody secret stored without encryption (legacy row)");
    return stored;
  }
  const [nonceHex, ctHex] = stored.slice(CUSTODY_ENC_PREFIX.length).split(":");
  const opened = nacl.secretbox.open(
    hexToBytes(ctHex),
    hexToBytes(nonceHex),
    custodyEncKey()
  );
  if (!opened) throw new Error("custody secret decryption failed");
  return new TextDecoder().decode(opened);
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
        // Enough for base reserves (1 XLM after the trustline subentry) plus
        // two Soroban txs at 0.2 XLM fee cap each on the recipient's claim.
        startingBalance: "2.5",
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
  amount: number; // raw stroops
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
      denom: args.amount, // DB column still named 'denom'; now stores stroop amount
      claim_payload: args.claimPayload,
      custody_stellar_address: args.custody.publicKey,
      custody_secret: encryptCustodySecret(args.custody.secret),
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
      // Decrypt the at-rest custody secret, then re-seal it to the recipient's
      // bullet pubkey so only they can open it.
      const custodySealed = sealTo(
        bulletPubKeyHex,
        decryptCustodySecret(inv.custody_secret)
      );
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

/** Poseidon([secret]) as 32-byte big-endian hex — the nullifier a claim proof
 *  binds. Byte-for-byte copy of frontend/src/lib/nullifier.ts's
 *  nullifierHexFromSecret, so a value computed here matches what the
 *  contract actually recorded. Not hoisted into shared/: this side's
 *  poseidon() (./poseidon.ts) reads circomlibjs's constants via node:fs at
 *  module load, while frontend/src/lib/poseidon.ts statically imports a
 *  bundled JSON copy so it works in the browser — unifying them would either
 *  add a circomlibjs dependency to shared/ or break the frontend bundle. */
export function nullifierHexFromSecret(secretHex: string): string {
  const secretDec = BigInt("0x" + secretHex).toString();
  const dec = poseidon([secretDec]);
  return decimalToHex32(dec);
}

/** Build the is_nullifier_used call, simulate it against `account`, and read
 *  back the bool result. Shared by isNullifierUsedOnChain (one-off check) and
 *  listInvitesForSender's reconciliation (many checks reusing one account). */
async function simulateIsNullifierUsed(
  rpc: StellarSdk.rpc.Server,
  contract: StellarSdk.Contract,
  account: StellarSdk.Account,
  nullifierHex: string
): Promise<boolean> {
  return simulateBoolView(
    rpc,
    contract,
    account,
    NETWORK_PASSPHRASE,
    "is_nullifier_used",
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(nullifierHex, "hex"))
  );
}

/** Read-only: ask the deployed contract whether this nullifier is spent, via
 *  a throwaway simulated (unsigned, unsubmitted) invocation of
 *  is_nullifier_used — the same public getter frontend/src/lib/nullifier.ts
 *  calls from the browser. The admin account (already funded for the
 *  indexer's post_root calls) only supplies the sim tx envelope's source;
 *  nothing is signed or sent. */
export async function isNullifierUsedOnChain(nullifierHex: string): Promise<boolean> {
  if (!CONTRACT_ID) throw new Error("ZEEKPAY_CONTRACT_ID not set");
  if (!ADMIN_KEY) throw new Error("ZEEKPAY_ADMIN_KEY not set");
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const sourcePub = StellarSdk.Keypair.fromSecret(ADMIN_KEY).publicKey();
  const account = await rpc.getAccount(sourcePub);
  return simulateIsNullifierUsed(rpc, contract, account, nullifierHex);
}

/** Build the rpc/contract/account ONCE, then return a checker closure that
 *  only does the per-nullifier simulate. Used by listInvitesForSender so a
 *  list call with N unclaimed rows does a single getAccount instead of N. */
async function prepareNullifierChecker(): Promise<
  (nullifierHex: string) => Promise<boolean>
> {
  if (!CONTRACT_ID) throw new Error("ZEEKPAY_CONTRACT_ID not set");
  if (!ADMIN_KEY) throw new Error("ZEEKPAY_ADMIN_KEY not set");
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const sourcePub = StellarSdk.Keypair.fromSecret(ADMIN_KEY).publicKey();
  const account = await rpc.getAccount(sourcePub);
  return (nullifierHex: string) =>
    simulateIsNullifierUsed(rpc, contract, account, nullifierHex);
}

interface PendingInviteRow {
  id: string;
  handle_normalized: string;
  denom: number;
  claim_payload: unknown;
  expires_at: string;
  delivered_at: string | null;
  claimed_at: string | null;
  refunded_at: string | null;
  created_at: string;
}

/** Sender's dashboard: their sent invites, newest first.
 *
 * The public claim-link path (frontend/src/app/c, claim_tx.ts's claimNote)
 * pays out straight to whatever wallet the claimer connects and never calls
 * this backend at all (see invite_claim.ts / markInviteClaimedIfOwned's
 * doc comment in store.ts for the other, backend-visible claim path this
 * one bypasses) — so an invite claimed that way never gets its claimed_at
 * stamped by anything else. Reconcile every still-unclaimed row against the
 * chain here, the same read-only nullifier check a human would do by hand.
 *
 * ponytail: one RPC simulate per unclaimed invite per list call. Fine for a
 * sender's handful of pending invites; the real upgrade path is the indexer
 * (indexer.ts) stamping claimed_at from on-chain claim events instead of
 * this page-load-time reconciliation.
 */
export async function listInvitesForSender(
  senderUserId: string,
  checkNullifierUsed?: (nullifierHex: string) => Promise<boolean>
): Promise<
  Array<{
    id: string;
    handle: string;
    amount: number; // raw stroops (DB column 'denom' holds this value)
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
      "id, handle_normalized, denom, claim_payload, expires_at, delivered_at, claimed_at, refunded_at, created_at"
    )
    .eq("sender_user_id", senderUserId)
    // Claimed invites belong in the sender's regular send history (already
    // recorded there when the invite was sent), not in this pending list.
    .is("claimed_at", null)
    .order("created_at", { ascending: false });
  if (error) return [];
  const rows = (data ?? []) as PendingInviteRow[];

  // Built lazily and memoized so at most one getAccount happens per list
  // call, shared by every row that actually needs a chain check — a sender
  // whose pending rows carry no claim_payload.secret never touches the
  // network at all.
  let checkerPromise: Promise<(nullifierHex: string) => Promise<boolean>> | null = null;
  const getChecker = () => {
    if (!checkerPromise) {
      checkerPromise = checkNullifierUsed
        ? Promise.resolve(checkNullifierUsed)
        : prepareNullifierChecker();
    }
    return checkerPromise;
  };

  async function claimedOnChain(r: PendingInviteRow): Promise<boolean> {
    const secret = (r.claim_payload as { secret?: string } | null)?.secret;
    if (!secret) return false;
    try {
      const check = await getChecker();
      return await check(nullifierHexFromSecret(secret));
    } catch (e) {
      // Never let a chain hiccup break the listing — the row just stays
      // pending until the next list call (or the sender actually claims
      // it through the app, which stamps it directly).
      console.error("[invite] nullifier check failed for", r.id, String(e).slice(0, 200));
      return false;
    }
  }

  const kept = (
    await Promise.all(rows.map(async (r) => ((await claimedOnChain(r)) ? null : r)))
  ).filter((r): r is PendingInviteRow => r !== null);

  const keptIds = new Set(kept.map((r) => r.id));
  const claimedIds = rows.filter((r) => !keptIds.has(r.id)).map((r) => r.id);
  if (claimedIds.length > 0) {
    await serviceClient
      .from("pending_invites")
      .update({ claimed_at: new Date().toISOString() })
      .in("id", claimedIds)
      .is("claimed_at", null);
  }

  return kept.map((r) => ({
    id: r.id,
    handle: r.handle_normalized,
    amount: r.denom,
    expires_at: r.expires_at,
    delivered_at: r.delivered_at,
    claimed_at: r.claimed_at,
    refunded_at: r.refunded_at,
    created_at: r.created_at,
  }));
}
