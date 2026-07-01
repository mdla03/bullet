# x-oauth-identity — Changes

## Files added / modified

### `backend/src/verify.ts` (new)
Ed25519 challenge construction and verification.

- `buildChallenge(handle, stellarAddress)` → `Buffer` of `"zeekpay-register-v1:{handle}:{stellarAddress}"`
- `verifyRegistrationSig(handle, stellarAddress, sigHex)` → `boolean`
  - Uses `Keypair.fromPublicKey()` from `@stellar/stellar-base`
  - Catches all exceptions (invalid key, malformed hex) → returns `false`

### `backend/src/pending.ts` (new)
In-memory TTL map for OAuth state → pending registration payload.

- `set(state, entry)` — stores with 5-min expiry; purges stale entries on write
- `get(state)` — returns entry or `undefined` if missing/expired; deletes on expiry
- `del(state)` — removes after successful register or on conflict

### `backend/src/twitter.ts` (new)
Twitter OAuth 2.0 PKCE helpers. Pure functions; all env vars read at call time (not module init) so tests can control them.

- `isConfigured()` — checks `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_OAUTH_CALLBACK_URL`
- `generatePKCE()` — 32-byte random `code_verifier` (base64url) + SHA-256 `code_challenge`
- `buildAuthUrl(state, codeChallenge)` — constructs Twitter authorize URL
- `exchangeCode(code, codeVerifier)` → `access_token` string
- `fetchUsername(accessToken)` → Twitter `username` string

No Twitter SDK — all calls use Node built-in `fetch`.

### `backend/src/resolver.ts` (modified)
Two new routes added. All imports moved to top.

**`POST /auth/twitter/start`**
1. 503 if Twitter not configured
2. Validates: handle starts with `@`, 1-15 alphanumeric/underscore body, valid Stellar key, 64-hex pubkey, 128-hex signature
3. Verifies Ed25519 sig over `"zeekpay-register-v1:{handle}:{stellarAddress}"`
4. Generates PKCE pair + UUID state; stores payload in pending map (5-min TTL)
5. Returns `{authUrl}` pointing to Twitter OAuth

**`GET /auth/twitter/callback`**
1. `?error` param → redirect `?error=cancelled`
2. Missing state/code → `?error=invalid_request`
3. Unknown/expired state → `?error=expired`
4. Exchanges code + code_verifier for access token
5. Fetches `/2/users/me` → verifies username matches handle (case-insensitive)
6. Mismatch → `?error=handle_mismatch`
7. Calls `store.register` → conflict → `?error=conflict`
8. Success → redirect `{FRONTEND_URL}/register?success=1&handle={handle}`

### `backend/package.json` (modified)
Added `@stellar/stellar-base` dependency.

### `backend/src/resolver.test.ts` (modified)
14 new tests across 4 new describe blocks (33 total, all pass).

## Key decisions

- **Challenge format**: `"zeekpay-register-v1:{handle}:{stellarAddress}"` — versioned, no timestamp (OAuth flow provides freshness via 5-min TTL).
- **Env vars read lazily** in `twitter.ts` — enables test-time manipulation without module re-import.
- **`POST /register` unchanged** — still accepts unverified sigs for testing/internal use; OAuth flow is the production path.
- **Twitter free tier** — 500k reads/month, no cost. Requires one-time app registration at `developer.twitter.com`.
- **Freighter `signBlob` convention**: frontend signs raw UTF-8 challenge bytes with Ed25519 (no prefix), converts base64 output to hex before sending. Documented for frontend-send feature.
