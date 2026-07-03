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

export type AttachWalletResult =
  | { ok: true; wallet: Wallet }
  | { conflict: true; detail: string };

/** Insert/upsert wallet for a user. stellar_address is globally unique. */
export async function attachWallet(
  userId: string,
  wallet: { stellar_address: string; bullet_pubkey: string; signature: string }
): Promise<AttachWalletResult> {
  const { data, error } = await serviceClient
    .from("wallets")
    .upsert(
      {
        user_id: userId,
        stellar_address: wallet.stellar_address,
        bullet_pubkey: wallet.bullet_pubkey,
        signature: wallet.signature,
      },
      { onConflict: "user_id" }
    )
    .select("*")
    .single();
  if (error) {
    // 23505 = unique_violation (someone else already claimed this stellar_address)
    if (error.code === "23505") {
      return { conflict: true, detail: "stellar_address already attached to another user" };
    }
    return { conflict: true, detail: error.message };
  }
  return { ok: true, wallet: data as Wallet };
}
