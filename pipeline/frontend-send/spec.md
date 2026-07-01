# frontend-send — Spec

## Goal

Next.js `/send` page: sender enters a recipient handle, picks a denomination,
connects Freighter, deposits a ZeekPay note on Soroban testnet, and receives a
shareable claim link to forward to the recipient out-of-band.

---

## Poseidon approach

`compute_hashes.wasm` is 2.5 MB — over the 1 MB commit limit. It is NOT
committed. Instead, the backend exposes `POST /commitment` which runs
`snarkjs wtns calculate` as a child process (wasm lives only on disk as a build
artifact of `pnpm build:circuits`). The frontend POSTs `{secret,
recipientDigest, denom}` and receives `{commitment}`.

Tradeoff: `secret` is sent to the backend — acceptable for hackathon demo;
documented as a known limitation. Production path: ship `compute_hashes.wasm`
via the backend as a served static file, load it with snarkjs in-browser.

---

## User journey

1. Enter recipient `@handle` or email in text field.
2. Pick denomination (1 / 10 / 50 / 100 USDC).
3. Click "Send" → Freighter connect popup.
4. Frontend resolves handle via `GET /resolve?q={handle}`.
5. Computes `recipientDigest = sha256(ScAddress_XDR(stellarAddress))` with
   top byte zeroed (Web Crypto `subtle.digest`).
6. Generates 32-byte random `secret` (`crypto.getRandomValues`).
7. `POST /commitment {secret, recipientDigest, denom}` → `{commitment}`.
8. Builds Soroban `deposit(from, denom, commitment)` transaction.
9. `rpcServer.prepareTransaction` → `signTransaction` (Freighter) → `sendTransaction`.
10. Shows shareable claim link (copy-to-clipboard).

---

## recipientDigest XDR

`ScAddress` for an account = 40 bytes:
```
[0x00000000]  SC_ADDRESS_TYPE_ACCOUNT discriminant
[0x00000000]  PUBLIC_KEY_TYPE_ED25519 discriminant
[32 bytes]    raw Ed25519 key
```

Use `xdr.ScAddress.scAddressTypeAccount(xdr.AccountId.publicKeyTypeEd25519(rawKey))`
from `@stellar/stellar-base` to produce exactly this encoding. Verified:
`xdrBytes.length === 40` ✓.

---

## Soroban deposit call

Contract signature (Protocol 22):
```rust
pub fn deposit(env: Env, from: Address, denom: Denom, commitment: BytesN<32>) -> Result<u64, Error>
```

XDR encoding from JS:
- `from`: `nativeToScVal(address, { type: "address" })`
- `denom`: `xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("One"|"Ten"|"Fifty"|"Hundred")])`
- `commitment`: `xdr.ScVal.scvBytes(bigIntToBytes32BE(commitment))`

---

## Claim link

Format: `{FRONTEND_URL}/claim?p={base64url(JSON.stringify(payload))}`

```typescript
interface ClaimPayload {
  secret: string;          // hex, 64 chars (32 bytes)
  recipientDigest: string; // decimal bigint
  denom: 1 | 10 | 50 | 100;
  contractId: string;
  network: "testnet";
}
```

---

## Files

### Backend (additions)
| File | Purpose |
|------|---------|
| `backend/src/commitment.ts` | snarkjs child-process commitment computation |
| `backend/src/resolver.ts` | add `POST /commitment` route |

### Frontend (new app)
| File | Purpose |
|------|---------|
| `frontend/next.config.ts` | Next.js 15 config |
| `frontend/tsconfig.json` | TypeScript NodeNext |
| `frontend/tailwind.config.ts` | Tailwind CSS |
| `frontend/postcss.config.mjs` | PostCSS |
| `frontend/src/app/globals.css` | Tailwind directives |
| `frontend/src/app/layout.tsx` | Root layout |
| `frontend/src/app/page.tsx` | Redirect → /send |
| `frontend/src/app/send/page.tsx` | Send page (server wrapper) |
| `frontend/src/components/SendForm.tsx` | Client form component |
| `frontend/src/lib/recipient.ts` | recipientDigest (XDR + sha256) |
| `frontend/src/lib/deposit.ts` | Soroban deposit transaction builder |
| `frontend/src/lib/claim_link.ts` | Encode / decode claim link |

---

## Env vars

```
# frontend (NEXT_PUBLIC_* exposed to browser)
NEXT_PUBLIC_RESOLVER_URL=http://localhost:3001
NEXT_PUBLIC_CONTRACT_ID=<deployed testnet contract>
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
NEXT_PUBLIC_FRONTEND_URL=http://localhost:3000
```

---

## Dependencies

Frontend:
- `next@15`, `react`, `react-dom`
- `@types/react`, `@types/react-dom`, `@types/node`, `typescript`
- `tailwindcss`, `postcss`, `autoprefixer`
- `@stellar/stellar-sdk` (Soroban RPC + transaction building)
- `@stellar/stellar-base` (XDR encoding for recipientDigest)
- `@stellar/freighter-api` (wallet connect + sign)

Backend (no new prod deps — snarkjs is already in circuits devDeps):

---

## Tests

- Backend `POST /commitment` tested manually (circuit build required).
- `encodeClaimLink` / `decodeClaimLink` are pure functions — unit-testable; not added to resolver.test.ts (separate package), but can be tested manually in browser console.
- Full UI: tested manually by running `pnpm dev` and submitting the form.

---

## Known limitations

- `secret` is sent to the backend to compute the commitment (privacy gap). Production fix: serve `compute_hashes.wasm` from backend, load via snarkjs in-browser.
- Freighter must be installed as a browser extension.
- Testnet only; contract must be deployed before demo (`NEXT_PUBLIC_CONTRACT_ID` set).
