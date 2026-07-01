# x-oauth-identity — Spec

## Goal

Gate `POST /register` behind two proofs:
1. **X (Twitter) identity proof** — OAuth 2.0 PKCE confirms the caller
   actually controls the X handle they claim.
2. **Stellar key ownership proof** — Ed25519 signature over a deterministic
   challenge confirms the caller controls the `stellarAddress` being registered.

Also finalizes **ZeekPay key derivation**: the `zeekPayPubKey` registered in
the resolver is derived from a Freighter Ed25519 signature over a fixed
domain-separated message (SPEC §7 "Key derivation").

---

## Scope

### What changes

| Area | Change |
|------|--------|
| `backend/src/resolver.ts` | Add `POST /auth/twitter/start`, `GET /auth/twitter/callback` routes. Add Ed25519 sig verification inside `POST /register`. |
| `backend/src/twitter.ts` (new) | Twitter OAuth 2.0 PKCE helpers: build auth URL, exchange code for token, fetch user info. Pure functions, zero state. |
| `backend/src/pending.ts` (new) | In-memory TTL map (5-min expiry) for OAuth state → registration payload. Auto-expires stale entries. |
| `backend/src/verify.ts` (new) | Ed25519 challenge construction + Stellar signature verification. Uses `@stellar/stellar-base` (lightweight, no full SDK needed). |
| `backend/package.json` | Add `@stellar/stellar-base`. |
| `.env.example` | Already has `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_OAUTH_CALLBACK_URL` — no change needed. |
| `backend/src/resolver.test.ts` | Add tests for new routes + signature verification. |

### What does NOT change

- `store.ts` — no structural changes; `register()` API unchanged.
- `shared/src/index.ts` — no new types needed.
- Circuit / contract code — untouched.

---

## Key derivation (SPEC §7 finalized here)

ZeekPay key derivation uses `signBlob` (Freighter API ≥ 5.x):

```
domain_msg = "zeekpay-key-v1"   // UTF-8, 15 bytes
zeekPayPrivKey = first 32 bytes of Ed25519 signature over domain_msg
zeekPayPubKey  = Ed25519 public key derived from zeekPayPrivKey (X25519 later)
```

The `zeekPayPubKey` stored in the resolver is the hex-encoded 32-byte value
derived by the frontend. The backend does NOT derive it — it only verifies
that the same Stellar key that signed the registration challenge also controls
the `stellarAddress`. `zeekPayPubKey` binding is a front-end responsibility
(documented in frontend-send spec).

---

## Registration challenge

Challenge is a deterministic UTF-8 string:

```
"zeekpay-register-v1:{handle}:{stellarAddress}"
```

- Frontend hashes or uses as-is.
- Frontend calls `signBlob(Buffer.from(challenge, 'utf8'))` via Freighter.
- Returns 64-byte Ed25519 signature (hex-encoded = 128 chars).
- Backend verifies: `Keypair.fromPublicKey(stellarAddress).verify(challengeBytes, sigBytes)`.
- No timestamp needed — the OAuth flow itself is the freshness proof (5-min pending TTL).

---

## HTTP routes (added to existing Express server)

### `POST /auth/twitter/start`

**Request body:**
```json
{
  "handle": "@alice",
  "stellarAddress": "G...",
  "zeekPayPubKey": "<64-hex>",
  "signature": "<128-hex Ed25519 sig over challenge>"
}
```

**Server actions:**
1. Validate all fields (same rules as `POST /register` + sig must be 128-hex).
2. Verify Ed25519 signature. Return `400` on failure.
3. Verify `handle` starts with `@` and is 2–16 chars (after `@`).
4. Generate `state` = `crypto.randomUUID()`, `code_verifier` = 43-char random base64url,
   `code_challenge` = SHA-256 of `code_verifier` (base64url).
5. Store `{handle, stellarAddress, zeekPayPubKey, signature, code_verifier}` in pending map under `state` (TTL 5 min).
6. Return `{authUrl: <Twitter OAuth 2.0 URL with state + code_challenge>}`.

**Response `200`:**
```json
{ "authUrl": "https://twitter.com/i/oauth2/authorize?..." }
```

**Error responses:** `400 {error, detail}`, `503` if env vars missing.

---

### `GET /auth/twitter/callback`

Query params: `code`, `state` (both required); optionally `error` (user denied).

**Server actions:**
1. If `error` param present → redirect to `{FRONTEND_URL}/register?error=cancelled`.
2. Look up pending entry by `state`. Missing/expired → redirect `?error=expired`.
3. Exchange `code` + `code_verifier` for access token (Twitter token endpoint).
4. Fetch `GET /2/users/me?user.fields=username` with bearer token.
5. Compare `username` (case-insensitive) to `handle` without `@`. Mismatch → redirect `?error=handle_mismatch`.
6. Call `store.register(pending entry)`. Conflict → redirect `?error=conflict`.
7. Delete pending entry.
8. Redirect to `{FRONTEND_URL}/register?success=1&handle={handle}`.

---

## Signature verification detail

```typescript
import { Keypair, hash } from "@stellar/stellar-base";

function buildChallenge(handle: string, stellarAddress: string): Buffer {
  return Buffer.from(`zeekpay-register-v1:${handle}:${stellarAddress}`, "utf8");
}

function verifyRegistrationSig(
  handle: string,
  stellarAddress: string,
  sigHex: string
): boolean {
  const kp = Keypair.fromPublicKey(stellarAddress);
  const challenge = buildChallenge(handle, stellarAddress);
  const sig = Buffer.from(sigHex, "hex");
  return kp.verify(challenge, sig);
}
```

`Keypair.fromPublicKey` throws on invalid Stellar address — caught → `400`.

---

## Env vars

| Var | Required | Description |
|-----|----------|-------------|
| `X_CLIENT_ID` | yes | Twitter OAuth 2.0 app client ID |
| `X_CLIENT_SECRET` | yes | Twitter OAuth 2.0 app client secret |
| `X_OAUTH_CALLBACK_URL` | yes | Must exactly match Twitter app setting, e.g. `http://localhost:3001/auth/twitter/callback` |
| `FRONTEND_URL` | yes | Where to redirect after OAuth, e.g. `http://localhost:3000` |
| `RESOLVER_PORT` | existing | No change |

If `X_CLIENT_ID` or `X_CLIENT_SECRET` missing at startup, server logs a warning but still starts
(health + resolve + register still work; `/auth/twitter/start` returns `503`).

---

## Twitter app setup (one-time, zero cost)

Free-tier Twitter developer account suffices:

1. `developer.twitter.com` → New Project → New App → OAuth 2.0 enabled.
2. Set **Callback URI**: `http://localhost:3001/auth/twitter/callback` (add production URL later).
3. Set **App permissions**: Read (no DM, no write needed).
4. Copy **Client ID** and **Client Secret** → `.env`.

Twitter free tier rate limits: 500k reads/month. Sufficient for hackathon demo.

---

## Dependencies

```
@stellar/stellar-base   # Ed25519 verify (lighter than full stellar-sdk)
```

No Twitter SDK — native `fetch` for token exchange + userinfo.

---

## Test plan

`backend/src/resolver.test.ts` additions (new describe blocks):

| # | Test | How |
|---|------|-----|
| 1 | `verifyRegistrationSig` accepts valid sig | Generate keypair in test, sign challenge, verify |
| 2 | `verifyRegistrationSig` rejects wrong sig | Mutate one byte of sig |
| 3 | `verifyRegistrationSig` rejects wrong stellarAddress | Different keypair |
| 4 | `buildChallenge` canonical form | String equality |
| 5 | `POST /auth/twitter/start` 503 when env vars missing | No `X_CLIENT_ID` set |
| 6 | `POST /auth/twitter/start` 400 on bad sig | Valid format, wrong sig |
| 7 | `POST /auth/twitter/start` 400 on invalid Stellar key | `notakey` |
| 8 | `POST /auth/twitter/start` 200 returns `{authUrl}` | Stub Twitter URL construction; no real HTTP |
| 9 | `GET /auth/twitter/callback` expired state → 302 `?error=expired` | No entry in pending map |
| 10 | pending map auto-expires entries after TTL | Fast-forward Date.now mock |

Twitter token exchange + userinfo NOT tested with real HTTP (would need credentials). Integration tested manually in e2e-demo.

---

## Out of scope

- Signature NOT re-verified on `POST /register` direct calls (no breaking change
  to existing API). The OAuth flow is the intended path; direct register remains
  for testing.
- Email ownership proof — deferred (no SendGrid yet).
- Refresh tokens — not needed; access token is used once to fetch username then discarded.
- Session cookies / JWT — no persistent login state; each register is one-shot.
