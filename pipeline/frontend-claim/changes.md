# frontend-claim — Changes

## Backend

### `backend/src/prove.ts` (new)
- `isProveReady()`: checks SNARKJS, CLAIM_WASM, CLAIM_ZKEY, HELPER_WASM, HELPER_SYM exist.
- `generateProof(secret, recipientDigest, denom)`:
  - Writes temp dir under `os.tmpdir()`; cleans up in `finally`.
  - Step 1: runs `snarkjs wtns calculate compute_hashes.wasm` → exports witness JSON →
    parses `.sym` to locate `main.nullifier`, `main.root`, `main.zeroHashes[i]`.
  - `pathElements[0] = "0"` (constant, optimized away in sym); `pathElements[i] = zeroHashes[i-1]`.
  - Step 2: builds `claim_input.json`; runs `snarkjs wtns calculate claim.wasm` then
    `snarkjs groth16 prove claim.zkey`.
  - Step 3: converts proof to Soroban hex (G1/G2/Fr big-endian encoding, Fp2 c1 before c0).
  - Returns `{ proof_a, proof_b, proof_c, nullifier, root }`.

### `backend/src/resolver.ts` (modified)
- Added `import * as prove from "./prove.js"` and `import * as StellarSdk`.
- Added `POST /prove`: validates inputs, calls `prove.generateProof`, returns result.
- Added `POST /post-root`: requires `ZEEKPAY_ADMIN_KEY` env; calls Soroban `post_root`
  via stellar-sdk (`rpc.prepareTransaction → keypair.sign → rpc.sendTransaction →
  rpc.pollTransaction`); returns `{ ok: true, hash }`.
- Fixed `pollTransaction` option: `{ attempts }` only (no `sleepTime`).

### `backend/package.json` (modified)
- Added `"@stellar/stellar-sdk": "^16.0.1"` to `dependencies`.

## Frontend

### `frontend/src/lib/claim_tx.ts` (new)
- `claimNote(connectedAddress, proofA, proofB, proofC, root, nullifier, denom, signTx)`:
  builds Soroban `claim(...)` tx, calls `signTx` callback for Freighter signing,
  submits, polls via `rpc.pollTransaction({ attempts: 30 })`, returns hash.

### `frontend/src/components/ClaimView.tsx` (modified)
- Added `proving`, `signing`, `submitting`, `done` states.
- `handleClaim()`: POST /prove → POST /post-root → `claimNote` with Freighter sign callback.
- `proveDetail` state shows sub-step label during `proving` ("Generating proof (~15 s)…" → "Posting Merkle root…").
- Errors reset to `matched` for retry.
- Done state shows success card with stellar.expert tx link.

## Env / config

### `.env.example` (modified)
- Added `ZEEKPAY_ADMIN_KEY`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE` (backend).
- Added `NEXT_PUBLIC_NETWORK_PASSPHRASE`, `NEXT_PUBLIC_FRONTEND_URL`, filled defaults
  for `NEXT_PUBLIC_SOROBAN_RPC_URL`, `NEXT_PUBLIC_RESOLVER_URL`, `RESOLVER_PORT`.
