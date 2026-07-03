// Supabase clients + JWT verification middleware.
//
// - serviceClient bypasses RLS (service role key). Backend uses it for
//   reads (resolve) and writes (wallet attach).
// - verifyJwt(token) hits Supabase's /auth/v1/user endpoint to validate the
//   access token and return the auth.users row (or null on any failure).
// - requireAuth middleware attaches req.userId or returns 401.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response, NextFunction } from "express";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!SUPABASE_ANON_KEY) throw new Error("SUPABASE_ANON_KEY is required");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

export const serviceClient: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Anon-key client used only to validate bearer JWTs via /auth/v1/user.
const anonClient: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export async function verifyJwt(token: string): Promise<string | null> {
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const hdr = req.header("authorization") ?? "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const userId = await verifyJwt(token);
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  (req as Request & { userId?: string }).userId = userId;
  next();
}
