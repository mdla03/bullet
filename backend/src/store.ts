// Bullet user store, backed by Supabase Postgres.
//
// Supabase manages auth.users and auth.identities. The public schema adds:
//   profiles       one row per user (auto-created by trigger)
//   handles        one row per linked identity (auto-created by trigger)
//   wallets        one row per user, added via /wallet/link
//
// All queries here use the service role, bypassing RLS.

import { serviceClient } from "./supabase.js";

export interface Wallet {
  user_id: string;
  stellar_address: string;
  bullet_pubkey: string;
  signature: string;
  attached_at: string;
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

  if (profileRes.error || !profileRes.data) return null;
  return {
    id: profileRes.data.id,
    createdAt: profileRes.data.created_at,
    identities: (handlesRes.data ?? []) as Handle[],
    wallet: (walletRes.data ?? null) as Wallet | null,
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
    .select("bullet_pubkey")
    .eq("user_id", userId)
    .maybeSingle();
  if (!wallet?.bullet_pubkey) return false;

  const { data, error } = await serviceClient
    .from("notes")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", noteId)
    .eq("recipient_pubkey", wallet.bullet_pubkey)
    .is("claimed_at", null)
    .select("id")
    .maybeSingle();
  if (error) return false;
  return !!data;
}

export type AttachWalletResult =
  | { ok: true; wallet: Wallet }
  | { conflict: true; detail: string };

/** Attach wallet to userId. If the wallet already belongs to another user,
 * merge that user INTO the current one: identities, handles, and existing
 * wallet row are reparented via the public.merge_users() function, then the
 * source user is deleted. Signature already validated at the route layer
 * (verifyLinkWalletSig) so the caller provably owns the wallet. */
export async function attachWallet(
  userId: string,
  wallet: { stellar_address: string; bullet_pubkey: string; signature: string }
): Promise<AttachWalletResult> {
  const row = {
    user_id: userId,
    stellar_address: wallet.stellar_address,
    bullet_pubkey: wallet.bullet_pubkey,
    signature: wallet.signature,
  };

  const { data: existing, error: findErr } = await serviceClient
    .from("wallets")
    .select("user_id")
    .eq("stellar_address", wallet.stellar_address)
    .maybeSingle();
  if (findErr) return { conflict: true, detail: findErr.message };

  if (existing && existing.user_id !== userId) {
    const { error: mergeErr } = await serviceClient.rpc("merge_users", {
      from_uid: existing.user_id,
      to_uid: userId,
    });
    if (mergeErr) return { conflict: true, detail: mergeErr.message };
  }

  const { data, error } = await serviceClient
    .from("wallets")
    .upsert(row, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) return { conflict: true, detail: error.message };
  return { ok: true, wallet: data as Wallet };
}
