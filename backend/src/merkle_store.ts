// Durable persistence for the Merkle tree, backed by Supabase Postgres.
//
// Source of truth for the indexer's leaves + ledger cursor. Replaces the old
// local-JSON persistence, which did not survive redeploys on an ephemeral host
// (Railway) and left deposited notes unclaimable. The in-memory tree
// (tree.ts / leaves.ts) is rebuilt from here on boot and written through on
// every new leaf.

import { serviceClient } from "./supabase.js";

/** All stored leaves with their contract leafIndex, ordered by index. Callers
 *  must place each at leafIndex, never at its array position: rows can have
 *  gaps. */
export async function loadLeaves(): Promise<{ leafIndex: number; commitment: string }[]> {
  const { data, error } = await serviceClient
    .from("merkle_leaves")
    .select("leaf_index, commitment")
    .order("leaf_index", { ascending: true });
  if (error) throw new Error(`loadLeaves: ${error.message}`);
  return (data ?? []).map((r) => ({
    leafIndex: r.leaf_index as number,
    commitment: r.commitment as string,
  }));
}

/** Persist one leaf at its index. Idempotent (index is the primary key). */
export async function appendLeaf(
  leafIndex: number,
  commitment: string
): Promise<void> {
  const { error } = await serviceClient
    .from("merkle_leaves")
    .upsert({ leaf_index: leafIndex, commitment }, { onConflict: "leaf_index" });
  if (error) throw new Error(`appendLeaf: ${error.message}`);
}

/** Persist several leaves in one round trip. Same idempotent (leaf_index PK)
 *  upsert semantics as appendLeaf, batched per indexer poll page instead of
 *  once per leaf. */
export async function appendLeaves(
  entries: { leafIndex: number; commitment: string }[]
): Promise<void> {
  if (entries.length === 0) return;
  const { error } = await serviceClient.from("merkle_leaves").upsert(
    entries.map((e) => ({ leaf_index: e.leafIndex, commitment: e.commitment })),
    { onConflict: "leaf_index" }
  );
  if (error) throw new Error(`appendLeaves: ${error.message}`);
}

/** Delete all leaves and reset cursor. Used when switching contracts. */
export async function clearAll(): Promise<void> {
  const { error: e1 } = await serviceClient.from("merkle_leaves").delete().gte("leaf_index", 0);
  if (e1) throw new Error(`clearAll leaves: ${e1.message}`);
  const { error: e2 } = await serviceClient.from("merkle_state").delete().eq("id", true);
  if (e2) throw new Error(`clearAll state: ${e2.message}`);
}

/** Last fully-processed ledger, or null if never set. */
export async function getCursor(): Promise<number | null> {
  const { data, error } = await serviceClient
    .from("merkle_state")
    .select("cursor_ledger")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(`getCursor: ${error.message}`);
  return data?.cursor_ledger ?? null;
}

export async function setCursor(ledger: number): Promise<void> {
  const { error } = await serviceClient
    .from("merkle_state")
    .upsert(
      { id: true, cursor_ledger: ledger, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
  if (error) throw new Error(`setCursor: ${error.message}`);
}
