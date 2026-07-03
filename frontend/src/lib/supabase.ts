import { createClient } from "@supabase/supabase-js";

// The publishable key is public by design (RLS enforces access); safe in the bundle.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
    "https://fxtxvierohxvvusmhkoa.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    "sb_publishable_elD3mcadGqiWcYZlUxE1sg_vqOh_Hq8"
);
