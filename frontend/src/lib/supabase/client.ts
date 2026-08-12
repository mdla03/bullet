import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL, timeoutFetch } from "./config";

/** Browser-side Supabase client. Reads the session from cookies set by the server. */
export function createClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set");
  }
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: timeoutFetch() },
  });
}
