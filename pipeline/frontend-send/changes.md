# frontend-send — Changes

## Backend

### `backend/src/commitment.ts` (new)
- Exports `isCircuitsReady()`: checks snarkjs CLI + wasm artifact exist.
- Exports `computeCommitment(secret, recipientDigest, denom)`: writes a temp witness input JSON, runs `snarkjs wtns calculate` (compute_hashes circuit), reads witness index 27 (`main.pathHashes[0]` = commitment), cleans temp files in `finally`.
- Paths derived from repo root relative to `import.meta.url`; no magic constants.
- Validates all three inputs are decimal bigints in range `[0, BLS_R)`.

### `backend/src/resolver.ts` (modified)
- Added `import cors from "cors"` + `app.use(cors())` so the frontend on `:3000` can call the backend on `:3001`.
- Added `import * as commitment from "./commitment.js"`.
- Added `POST /commitment` route: validates presence of `secret`, `recipientDigest`, `denom`; returns 503 if circuits not built; runs `commitment.computeCommitment`; returns `{ commitment: string }`.

## Frontend (new Next.js app)

| File | Change |
|------|--------|
| `frontend/next.config.ts` | webpack `false` fallbacks for Node.js-only modules (fs, net, tls, crypto, etc.) that stellar-sdk pulls in at import time but are unused in browser |
| `frontend/tsconfig.json` | target ES2017, module esnext, moduleResolution bundler, jsx preserve, strict, Next.js plugin |
| `frontend/postcss.config.mjs` | `@tailwindcss/postcss` plugin (Tailwind v4 format) |
| `frontend/src/app/globals.css` | `@import "tailwindcss"` (Tailwind v4 format, no config file) |
| `frontend/src/app/layout.tsx` | Dark theme root layout; Metadata; `bg-gray-950 text-gray-100`; max-w-lg centered card |
| `frontend/src/app/page.tsx` | `redirect("/send")` |
| `frontend/src/app/send/page.tsx` | Server component wrapping `<SendForm />` |
| `frontend/src/components/SendForm.tsx` | "use client"; full send flow state machine; dynamic Freighter import |
| `frontend/src/lib/recipient.ts` | `computeRecipientDigest(stellarAddress)` — XDR ScAddress → SHA-256 → top byte zeroed → bigint |
| `frontend/src/lib/deposit.ts` | `depositNote(sender, commitment, denom, signTx)` — Soroban deposit transaction via rpc.Server |
| `frontend/src/lib/claim_link.ts` | `encodeClaimLink` / `decodeClaimLink` — base64url JSON claim payload |
| `frontend/src/declarations.d.ts` | CSS module type declaration (`declare module "*.css"`) |
| `frontend/package.json` | Updated scripts; deps: next@15, react@19, @stellar/* v15-16, freighter-api v6; devDeps: tailwindcss@4, @tailwindcss/postcss |

## Fixes during implementation

| Problem | Fix |
|---------|-----|
| `xdr.AccountId` not a class (type alias for `PublicKey`) | Use `xdr.PublicKey.publicKeyTypeEd25519(raw)` |
| `crypto.subtle.digest` rejects `Buffer` (`buffer: ArrayBufferLike`) | Wrap: `new Uint8Array(xdrBytes)` |
| Tailwind v3 config incompatible with v4 | Deleted `tailwind.config.ts`; `postcss.config.mjs` uses `@tailwindcss/postcss`; `globals.css` uses `@import "tailwindcss"` |
| TypeScript: no type for CSS side-effect import | Added `frontend/src/declarations.d.ts` with `declare module "*.css"` |
