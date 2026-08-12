// Single source for the Supabase endpoint. Deliberately no fallback value: a
// stale hardcoded project URL points every client at a host that no longer
// exists, which fails as a hang rather than an error.
// The publishable key is public by design (RLS enforces access); safe in the bundle.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Bound every Supabase call so an unreachable or paused project cannot hang the request. */
export function timeoutFetch(timeoutMs = 3000): typeof fetch {
  return (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
