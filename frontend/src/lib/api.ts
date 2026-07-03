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
}

export async function getMe(): Promise<MeResponse> {
  const res = await apiFetch("/me");
  if (!res.ok) throw new Error(`/me failed (${res.status})`);
  return res.json();
}
