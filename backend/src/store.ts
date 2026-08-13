// Bullet user store, backed by Supabase Postgres.
//
// Supabase manages auth.users and auth.identities. The public schema adds:
//   profiles       one row per user (auto-created by trigger)
//   handles        one row per linked identity (auto-created by trigger)
//   wallets        one row per user, added via /wallet/link
//
// All queries here use the service role, bypassing RLS.

import { serviceClient } from "./supabase.js";

/** A wallet this user linked before switching to the current one. Bullet keys
 *  are derived from a wallet's signature, so a switch changes bullet_pubkey and
 *  strands notes addressed to the old key. Keeping the old keys is what makes
 *  those notes findable (and claimable, by reconnecting that wallet). */
export interface PreviousWallet {
  stellar_address: string;
  bullet_pubkey: string;
  unlinked_at: string;
}

export interface Wallet {
  user_id: string;
  stellar_address: string;
  bullet_pubkey: string;
  signature: string;
  attached_at: string;
  previous: PreviousWallet[];
}

/** Every Bullet pubkey this account has ever published, current first. Deduped:
 *  switching back to an earlier wallet leaves it in both places. */
export function allPubkeys(wallet: {
  bullet_pubkey: string;
  previous?: PreviousWallet[] | null;
}): string[] {
  return [
    ...new Set([
      wallet.bullet_pubkey,
      ...(wallet.previous ?? []).map((p) => p.bullet_pubkey),
    ]),
  ];
}

/** History after linking a wallet with `incomingPubkey` over `current`.
 *  Re-linking the same wallet is a no-op, so an idempotent retry cannot push a
 *  duplicate entry. Pure so the append rule is testable without Supabase. */
export function nextPrevious(
  current: {
    stellar_address: string;
    bullet_pubkey: string;
    previous?: PreviousWallet[] | null;
  } | null,
  incomingPubkey: string,
  now: string = new Date().toISOString()
): PreviousWallet[] {
  const previous = [...(current?.previous ?? [])];
  if (!current || current.bullet_pubkey === incomingPubkey) return previous;
  return [
    ...previous,
    {
      stellar_address: current.stellar_address,
      bullet_pubkey: current.bullet_pubkey,
      unlinked_at: now,
    },
  ];
}

export interface Handle {
  provider: string;
  subject: string;
  handle: string;
  linked_at: string;
}

export interface UserProfile {
  id: string;
  createdAt: string;
  identities: Handle[];
  wallet: Wallet | null;
  unreadCount: number;
}

function normalizeKey(q: string): string {
  const t = q.trim();
  return t.startsWith("@") ? "@" + t.slice(1).toLowerCase() : t.toLowerCase();
}

/** Public lookup used by /resolve. Returns the user + wallet (or null). */
export async function findByLookup(query: string): Promise<UserProfile | null> {
  const key = normalizeKey(query);
  const { data: h, error: e1 } = await serviceClient
    .from("handles")
    .select("user_id")
    .eq("handle_normalized", key)
    .maybeSingle();
  if (e1 || !h) return null;
  return getUser(h.user_id);
}

/** Full user aggregate: profile + all handles + wallet (if any). */
export async function getUser(userId: string): Promise<UserProfile | null> {
  const [profileRes, handlesRes, walletRes] = await Promise.all([
    serviceClient.from("profiles").select("id, created_at").eq("id", userId).maybeSingle(),
    serviceClient
      .from("handles")
      .select("provider, subject, handle, linked_at")
      .eq("user_id", userId)
      .order("linked_at", { ascending: true }),
    serviceClient.from("wallets").select("*").eq("user_id", userId).maybeSingle(),
  ]);

  if (profileRes.error) return null;

  // Heal a missing profile row lazily. The trigger normally auto-creates one
  // on auth.users insert, but OTP/magic-link signups occasionally race the
  // trigger or land users here before it fires, surfacing a spurious 404 in
  // the UI. Upsert-and-refetch is idempotent under concurrent calls.
  let profile = profileRes.data;
  if (!profile) {
    const { data: created, error } = await serviceClient
      .from("profiles")
      .upsert({ id: userId }, { onConflict: "id" })
      .select("id, created_at")
      .single();
    if (error || !created) return null;
    profile = created;
  }

  const walletRow = walletRes.data as (Wallet & { previous: PreviousWallet[] | null }) | null;
  const wallet: Wallet | null = walletRow
    ? { ...walletRow, previous: walletRow.previous ?? [] }
    : null;
  let unreadCount = 0;
  if (wallet) {
    // Count across previous wallets too, or the badge reads 0 right after a
    // wallet switch while real unclaimed notes sit on the old key.
    const { count } = await serviceClient
      .from("notes")
      .select("id", { count: "exact", head: true })
      .in("recipient_pubkey", allPubkeys(wallet))
      .is("claimed_at", null);
    unreadCount = count ?? 0;
  }

  return {
    id: profile.id,
    createdAt: profile.created_at,
    identities: (handlesRes.data ?? []) as Handle[],
    wallet,
    unreadCount,
  };
}

/** Mark a note claimed only if it's addressed to the caller's own wallet
 * bullet_pubkey. Prevents griefing under the RLS-locked notes table. */
export async function markNoteClaimedIfOwned(
  userId: string,
  noteId: string
): Promise<boolean> {
  const { data: wallet } = await serviceClient
    .from("wallets")
    .select("bullet_pubkey, previous")
    .eq("user_id", userId)
    .maybeSingle();
  if (!wallet?.bullet_pubkey) return false;

  // Previous keys included: claiming a note stranded on an old wallet must
  // still be able to stamp it claimed.
  const { data, error } = await serviceClient
    .from("notes")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", noteId)
    .in("recipient_pubkey", allPubkeys(wallet))
    .select("id")
    .maybeSingle();
  if (error) return false;
  return !!data;
}

/** True iff some wallet row publishes this bullet pubkey. Used to reject inbox
 *  deliveries addressed to keys that were never registered (anti-spam). */
export async function pubkeyIsRegistered(bulletPubKey: string): Promise<boolean> {
  const { data } = await serviceClient
    .from("wallets")
    .select("user_id")
    .eq("bullet_pubkey", bulletPubKey)
    .maybeSingle();
  if (data) return true;

  // Also accept previously-linked keys. A sender who resolved the handle just
  // before the recipient switched wallets builds a note for the old key;
  // rejecting it here would turn a recoverable race into a lost payment.
  const { data: prior } = await serviceClient
    .from("wallets")
    .select("user_id")
    .contains("previous", [{ bullet_pubkey: bulletPubKey }])
    .maybeSingle();
  return !!prior;
}

/** Insert an encrypted inbox note via the service role (notes INSERT is
 *  RLS-locked; browsers go through the backend). Returns false on error. */
export async function insertNote(row: {
  recipient_pubkey: string;
  ephemeral_pubkey: string;
  nonce: string;
  ciphertext: string;
}): Promise<boolean> {
  const { error } = await serviceClient.from("notes").insert(row);
  return !error;
}

// ── activity ──────────────────────────────────────────────────────────────────

export interface Activity {
  id: string;
  type: "send" | "claim";
  amount: number;
  token_id: number;
  tx_hash: string | null;
  handle: string | null;
  created_at: string;
}

export async function insertActivity(
  userId: string,
  row: { type: "send" | "claim"; amount: number; token_id?: number; tx_hash?: string; handle?: string }
): Promise<boolean> {
  const { error } = await serviceClient.from("activity").insert({
    user_id: userId,
    type: row.type,
    amount: row.amount,
    token_id: row.token_id ?? 0,
    tx_hash: row.tx_hash ?? null,
    handle: row.handle ?? null,
  });
  return !error;
}

export async function listActivity(userId: string): Promise<Activity[]> {
  const { data, error } = await serviceClient
    .from("activity")
    .select("id, type, amount, token_id, tx_hash, handle, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return [];
  return ((data ?? []) as (Omit<Activity, "token_id"> & { token_id?: number | null })[]).map(
    (r) => ({ ...r, token_id: r.token_id ?? 0 })
  );
}

// ── wallet ────────────────────────────────────────────────────────────────────

export type AttachWalletResult =
  | { ok: true; wallet: Wallet }
  | { conflict: true; detail: string }
  | { mergeRequired: true; account: { handles: string[]; stellar_address: string } };

/** Attach wallet to userId, replacing whatever wallet is linked now. The old
 * wallet is appended to `previous` (never dropped) so notes addressed to its
 * Bullet key stay findable and claimable.
 *
 * If the wallet already belongs to another user, that user is merged INTO the
 * current one: identities, handles, and existing wallet row are reparented via
 * the public.merge_users() function, then the source user is deleted. That is
 * destructive and irreversible, so it happens ONLY with confirmMerge: the
 * caller must have shown the user what gets absorbed.
 *
 * Signature already validated at the route layer (verifyLinkWalletSig) so the
 * caller provably owns the wallet. */
export async function attachWallet(
  userId: string,
  wallet: { stellar_address: string; bullet_pubkey: string; signature: string },
  opts: { confirmMerge?: boolean } = {}
): Promise<AttachWalletResult> {
  const { data: existing, error: findErr } = await serviceClient
    .from("wallets")
    .select("user_id")
    .eq("stellar_address", wallet.stellar_address)
    .maybeSingle();
  if (findErr) return { conflict: true, detail: findErr.message };

  if (existing && existing.user_id !== userId) {
    if (!opts.confirmMerge) {
      const { data: handles } = await serviceClient
        .from("handles")
        .select("handle")
        .eq("user_id", existing.user_id);
      return {
        mergeRequired: true,
        account: {
          handles: (handles ?? []).map((h) => h.handle as string),
          stellar_address: wallet.stellar_address,
        },
      };
    }
    const { error: mergeErr } = await serviceClient.rpc("merge_users", {
      from_uid: existing.user_id,
      to_uid: userId,
    });
    if (mergeErr) return { conflict: true, detail: mergeErr.message };
  }

  // Keep the outgoing wallet so its notes stay findable.
  const { data: current } = await serviceClient
    .from("wallets")
    .select("stellar_address, bullet_pubkey, previous")
    .eq("user_id", userId)
    .maybeSingle();

  const previous = nextPrevious(
    current as {
      stellar_address: string;
      bullet_pubkey: string;
      previous?: PreviousWallet[] | null;
    } | null,
    wallet.bullet_pubkey
  );

  const { data, error } = await serviceClient
    .from("wallets")
    .upsert(
      {
        user_id: userId,
        stellar_address: wallet.stellar_address,
        bullet_pubkey: wallet.bullet_pubkey,
        signature: wallet.signature,
        previous,
      },
      { onConflict: "user_id" }
    )
    .select("*")
    .single();
  if (error) return { conflict: true, detail: error.message };
  return { ok: true, wallet: { ...(data as Wallet), previous } };
}
