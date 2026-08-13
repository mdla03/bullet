import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, timeoutFetch } from "./config";

/** Service-role Supabase client. SERVER ONLY — never import from a Client
 *  Component. Bypasses RLS, so every caller must gate on the admin allowlist
 *  first (see app/dashboard/page.tsx). */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  }
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false },
    global: { fetch: timeoutFetch(8000) },
  });
}

/** Emails allowed into the dashboard. Empty = nobody (fail closed). */
export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const allow = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.toLowerCase());
}
