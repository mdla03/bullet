// Durable persistence for the Merkle tree, backed by Supabase Postgres.
//
// Source of truth for the indexer's leaves + ledger cursor. Replaces the old
// local-JSON persistence, which did not survive redeploys on an ephemeral host
// (Railway) and left deposited notes unclaimable. The in-memory tree
// (tree.ts / leaves.ts) is rebuilt from here on boot and written through on
// every new leaf.

import { serviceClient } from "./supabase.js";

/** All leaves ordered by index (position == leafIndex in the tree). */
export async function loadLeaves(): Promise<string[]> {
  const { data, error } = await serviceClient
    .from("merkle_leaves")
    .select("leaf_index, commitment")
    .order("leaf_index", { ascending: true });
  if (error) throw new Error(`loadLeaves: ${error.message}`);
  return (data ?? []).map((r) => r.commitment as string);
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
