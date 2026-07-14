import { createClient } from "@/lib/supabase/client";

export const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";

/**
 * Fetch a backend resolver route with the caller's Supabase access token.
 * Use for authenticated routes (/me, /wallet/link). Throws if no session.
 */
export async function apiFetch(path: string, init: RequestInit = {}) {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${RESOLVER_URL}${path}`, { ...init, headers });
}

export interface MeResponse {
  authenticated: boolean;
  userId: string;
  identities: { provider: string; handle?: string }[];
  wallet: { stellar_address: string; bullet_pubkey: string } | null;
  unreadCount: number;
}

export interface ActivityItem {
  id: string;
  type: "send" | "claim";
  amount: number;
  token_id: number;
  tx_hash: string | null;
  handle: string | null;
  created_at: string;
}

export async function postActivity(row: {
  type: "send" | "claim";
  amount: number;
  tokenId?: number;
  txHash?: string;
  handle?: string;
}): Promise<void> {
  await apiFetch("/activity", {
    method: "POST",
    body: JSON.stringify(row),
  }).catch(() => {}); // best-effort
}

export async function getActivity(): Promise<ActivityItem[]> {
  const res = await apiFetch("/activity");
  if (!res.ok) return [];
  const json = (await res.json()) as { items: ActivityItem[] };
  return json.items;
}

/**
 * Look up which auth providers an email is registered with. Public endpoint.
 * Used by the sign-in flow to detect OAuth-only accounts before wasting a
 * magic-link send that Supabase would silently drop.
 */
export async function lookupEmailProviders(
  email: string
): Promise<{ exists: boolean; providers: string[] }> {
  const res = await fetch(
    `${RESOLVER_URL}/auth/lookup?email=${encodeURIComponent(email)}`
  );
  if (!res.ok) return { exists: false, providers: [] };
  return res.json();
}

export async function getMe(): Promise<MeResponse> {
  const res = await apiFetch("/me");
  if (!res.ok) throw new Error(`/me failed (${res.status})`);
  return res.json();
}
