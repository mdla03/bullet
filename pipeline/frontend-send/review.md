# frontend-send — Review

## Security

- **Secret sent to backend** (privacy gap): `secret` is a ZK circuit input that
  should only be known to the sender. The backend needs it to run snarkjs. Documented
  in spec as an acceptable hackathon tradeoff. Production fix: serve wasm via the
  backend as a static file and load it with snarkjs in-browser so the secret never
  leaves the client.
- No server-side secrets exposed in frontend env vars (all `NEXT_PUBLIC_*` are
  intentionally public).
- CORS added as `cors()` (allow-all). Acceptable for hackathon; production should
  restrict to the known frontend origin.

## Correctness

- `recipientDigest` XDR encoding: `PublicKey.publicKeyTypeEd25519(raw)` →
  `ScAddress.scAddressTypeAccount(...)` → `.toXDR()` → 40 bytes — matches what
  the Soroban contract computes via `recipient.to_xdr(env)`. ✓
- Top byte zeroed ensures `recipientDigest < BLS12-381 r` (255 bits). ✓
- `Denom` encoded as `ScVec([ScSymbol("One"|"Ten"|"Fifty"|"Hundred")])` — matches
  Soroban unit enum encoding. ✓
- Commitment is a 32-byte big-endian bigint passed as `scvBytes`. ✓
- Claim link carries `secret` as hex so the claim page can reconstruct the proof
  inputs without the backend.

## Architecture

- Dynamic import of `@stellar/freighter-api` (`await import(...)`) correctly defers
  the browser-extension API to runtime, not module load time. ✓
- `next.config.ts` webpack fallbacks prevent stellar-sdk Node.js builtins from
  breaking the browser bundle. ✓
- `signTx` callback parameter in `depositNote` cleanly separates transaction
  building from signing, making the function testable without a browser wallet.

## Known limitations (carried forward)

- Freighter v6 `signTransaction` API shape assumed: `{ signedTxXdr } | { error }`.
  Verify against Freighter docs at demo time.
- `rpc.sendTransaction` returns immediately; no polling for `PENDING → SUCCESS`.
  The tx hash is shown but the deposit may not be finalized yet. Add polling in
  the e2e-demo feature if needed.
- No `extend_ttl` on nullifier storage (pre-existing gap from soroban-contract).
