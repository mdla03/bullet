// GitHub identity verification for the /resolve unregistered-candidate path
// (resolver.ts's unregisteredCandidatesFor). A string merely matching
// GitHub's username syntax (letters/digits/hyphens, <= 39 chars) is not
// evidence that account exists - gibberish can fit that syntax as easily as
// a real login. This confirms the login before that candidate list ever
// presents an avatar + profile as a real, existing person.
//
// HEAD against the profile page (github.com), not GET against the REST API
// (api.github.com): the API's unauthenticated rate limit is 60 requests per
// hour PER IP, and every user of this resolver shares the backend server's
// one IP - a handful of lookups would exhaust it for everyone, after which
// every real GitHub handle would fail closed to "not found" too. The profile
// page returns 200 for a user or org and 404 otherwise, with no body to
// discard on a HEAD request, and isn't covered by the API's rate limit.
//
// ponytail: no cache, add a short TTL map if github.com starts throttling.
export async function githubUserExists(login: string): Promise<boolean> {
  try {
    const res = await fetch(`https://github.com/${encodeURIComponent(login)}`, {
      method: "HEAD",
      headers: { "User-Agent": "bullet-resolver" },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    // Network error, timeout, or rate limiting: fail closed. Showing no card
    // is safer than showing an unverified one in a payments flow.
    return false;
  }
}
