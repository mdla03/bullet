import { createBrowserClient } from "@supabase/ssr";

// The publishable key is public by design (RLS enforces access); safe in the bundle.
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "https://fxtxvierohxvvusmhkoa.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_elD3mcadGqiWcYZlUxE1sg_vqOh_Hq8";

/** Browser-side Supabase client. Reads the session from cookies set by the server. */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
