# resolver-service — Plan (spec.md)

## Goal

Build the ZeekPay resolver HTTP service in `backend/`. It maps an X handle or
email to `{stellarAddress, zeekPayPubKey, contractAddress, usdcSac}` so that
`frontend-send` can initiate a payment without knowing any contract addresses
upfront. Also provides the registration endpoint that `x-oauth-identity` will
call when a user completes their ZeekPay sign-in flow.

---

## What the resolver resolves

| Input | Returns |
|-------|---------|
| Registered X handle (e.g. `@alice`) | `{found: true, stellarAddress, zeekPayPubKey, contractAddress, usdcSac}` |
| Registered email | same |
| Unregistered / unknown | `{found: false}` — frontend handles this via the copy-paste-claim-link flow |

**`zeekPayPubKey`** — hex-encoded 32-byte X25519 public key derived from the
user's Freighter signature (exact derivation locked in `x-oauth-identity`). The
resolver stores and returns it opaquely; does not interpret or verify it beyond
being a 64-char hex string.

**`contractAddress`** — `ZEEKPAY_CONTRACT_ID` from env; same value returned for
all requests.

**`usdcSac`** — `USDC_SAC_ID` from env; same value returned for all requests.

---

## API (three endpoints)

### `GET /health`
Returns `200 {"ok": true}`. Used by `pnpm dev` readiness check.

### `GET /resolve?q=<query>`
`q` is a raw string. Resolver normalizes:
- X handles: strip leading `@`, lowercase → lookup key `@<normalized>`
- Emails: lowercase → lookup key `<email>`
- Query starting with `@` → treated as X handle; otherwise treated as email

**Response 200:**
```json
{
  "found": true,
  "stellarAddress": "G...",
  "zeekPayPubKey": "<64-char hex>",
  "contractAddress": "<env value>",
  "usdcSac": "<env value>"
}
```
or
```json
{ "found": false }
```

No 404 — always 200. `found: false` is not an error; it's a valid state that
drives the UI into the copy-paste-claim-link flow.

### `POST /register`
Body (JSON):
```json
{
  "handle":         "@alice",        // optional; at least one of handle/email required
  "email":          "a@example.com", // optional
  "stellarAddress": "G...",
  "zeekPayPubKey":  "<64-char hex>",
  "signature":      "<hex>"          // Freighter signature proving key ownership
                                     // (format locked in x-oauth-identity; stored
                                     //  but NOT verified in this feature — P0 placeholder)
}
```

**Responses:**
- `200 {"ok": true}` — registered (or re-registered with same values, idempotent)
- `409 {"error": "conflict", "detail": "..."}` — handle/email already registered
  to a DIFFERENT stellarAddress (re-registration for same address is allowed)
- `400 {"error": "invalid_input", "detail": "..."}` — malformed request

**Security note (P0 placeholder):** Signature is stored but NOT verified in
this feature. Any caller can register any handle/address combination. This is
acceptable because:
- Testnet only; no real funds
- x-oauth-identity adds the actual X OAuth + Freighter signature verification
- The register endpoint is not public-facing in the demo flow (called by the
  frontend after completing x-oauth-identity OAuth)

---

## Data store

No database dependency. Simple in-memory `Map<string, Entry>` backed by a JSON
file persisted on every write.

```typescript
interface Entry {
  handle?: string;
  email?: string;
  stellarAddress: string;
  zeekPayPubKey: string;
  signature: string;
  registeredAt: string;  // ISO timestamp
}
```

Persistence file: `backend/data/registry.json` — gitignored (runtime data,
not code). Created on first register call if missing.

On startup: load file into memory if it exists; start fresh otherwise.

---

## Files to create / modify

### New
- `backend/src/resolver.ts` — HTTP server (Express) + route handlers
- `backend/src/store.ts` — in-memory registry + JSON persistence
- `backend/data/.gitkeep` — ensures `data/` dir is tracked; actual JSON gitignored
- `backend/tsconfig.json` — TypeScript config (ESM, Node22 target)

### Modified
- `backend/package.json` — add `express`, `@types/express`, `typescript`,
  `tsx` (for dev); wire `dev` + `build` scripts
- `shared/src/index.ts` — export `ResolveResult`, `RegisterRequest` types
- `.env.example` — verify `RESOLVER_PORT`, `ZEEKPAY_CONTRACT_ID`, `USDC_SAC_ID`
  are present (they already are; no change needed)
- `.gitignore` — add `backend/data/registry.json`

### Not modified
- `contracts/` — no changes
- `circuits/` — no changes
- `frontend/` — no changes (frontend-send will wire up the resolve call)

---

## Dependencies to add

| Package | Where | Reason |
|---------|-------|--------|
| `express` | backend prod | HTTP routing |
| `@types/express` | backend dev | TypeScript types |
| `typescript` | backend dev | TS compiler |
| `tsx` | backend dev | Dev server (runs `.ts` directly, zero config) |

No DB client. No external API calls. Zero runtime cost.

---

## Shared types (shared/src/index.ts)

```typescript
export interface ResolveResult {
  found: boolean;
  stellarAddress?: string;
  zeekPayPubKey?: string;
  contractAddress?: string;
  usdcSac?: string;
}

export interface RegisterRequest {
  handle?: string;
  email?: string;
  stellarAddress: string;
  zeekPayPubKey: string;
  signature: string;
}
```

---

## Input validation (boundary guards)

- `stellarAddress`: must match `/^G[A-Z2-7]{55}$/` (56-char Stellar public key)
- `zeekPayPubKey`: must match `/^[0-9a-f]{64}$/` (32-byte hex)
- `q` on resolve: non-empty, ≤ 256 chars
- At least one of `handle` or `email` required on register
- Email: simple format check `/^[^@]+@[^@]+\.[^@]+$/`

No other validation at this layer — content correctness is x-oauth-identity's job.

---

## Design gaps (carried forward)

1. **Unregistered recipient binding in commitments** — if `found: false`, the
   UI falls back to the copy-paste-claim-link flow. That feature must decide
   how commitments are built for unregistered recipients (binding to a
   one-time address, a zero digest, or deferring until registration). This
   resolver does not need to solve it.
2. **Signature verification** — stored but unverified until x-oauth-identity
   adds the verification step.
3. **Handle uniqueness across providers** — resolver normalizes X handles with
   `@` prefix, emails as plain. No namespace collision is possible between them.
   Multi-provider identity (same person, two handles) is not solved.

---

## Test plan (test-results.md will capture real output)

1. **Unit: resolve known handle** — register `@alice`, resolve `@alice` and
   `@Alice` (case-insensitive) → `found: true` with correct fields.
2. **Unit: resolve unknown handle** → `{found: false}`.
3. **Unit: re-register same address** — idempotent, returns 200.
4. **Unit: conflict** — register `@alice` to address A, then to address B → 409.
5. **Unit: invalid stellarAddress** → 400.
6. **Unit: invalid zeekPayPubKey** → 400.
7. **Integration: `pnpm dev` (backend)** — server starts, `GET /health` → 200.
8. **Integration: persistence** — register, restart server, resolve → still found.

Tests live in `backend/src/resolver.test.ts`, run with Node's built-in test
runner (`node --test`). No Jest/Vitest dep added.
