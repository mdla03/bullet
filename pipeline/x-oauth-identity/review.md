# x-oauth-identity — Review

## Security checklist

| # | Item | Status |
|---|------|--------|
| 1 | No secrets in code | ✅ All via env vars, read at call time |
| 2 | PKCE used (not implicit/password grant) | ✅ `S256` code challenge |
| 3 | State param is random UUID | ✅ `crypto.randomUUID()` |
| 4 | Pending entries expire | ✅ 5-min TTL; checked on read |
| 5 | Ed25519 sig verified before storing state | ✅ Invalid sig → 400 before any OAuth redirect |
| 6 | Twitter username compared case-insensitively | ✅ Both sides `.toLowerCase()` |
| 7 | Pending entry deleted after use | ✅ `pending.del(state)` before redirect |
| 8 | No redirect-to-arbitrary-URL | ✅ `FRONTEND_URL` from env, not from user input |
| 9 | No access token stored | ✅ Used once, discarded |
| 10 | No mainnet / paid APIs | ✅ Twitter free tier only |

## Known gaps (deferred)

| Gap | Deferred to |
|-----|-------------|
| `POST /register` direct path still accepts unverified sigs | Acceptable for testing; production callers should use OAuth flow |
| No rate limiting on `/auth/twitter/start` | P1 / before public launch |
| Pending map is in-process (restarts lose pending entries) | Acceptable for MVP; swap to Redis/KV if multi-instance |
| Twitter access token used for one call then abandoned (no revocation) | Fine — token has no write permissions |
| Frontend `signBlob` → hex conversion not tested here | Covered in frontend-send feature |
| Email-based identity proof | Deferred to SendGrid (P1) |

## Key invariant

Both proofs must pass before registry write:
1. Ed25519 sig → proves caller controls `stellarAddress`
2. Twitter OAuth → proves caller controls the X `handle`

Neither proof alone is sufficient. The pending-map TTL ensures they can't be separated by more than 5 minutes.
