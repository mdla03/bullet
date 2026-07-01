# e2e-demo — Changes

## Contract deployment (testnet, 2026-07-01)

| Item | Value |
|------|-------|
| Contract | `CC2RTZTQKONWFUFHZA3GT3VJGAQ2YCSEHFLIWMEZXQH65WQ5AWU5FW5R` |
| Token SAC (native XLM) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Admin account | `GCOM3SQ7V633YHCAQSHEDSPTQT2ZY3LCSN7EOS5FEUY4SZI7PG7QLESS` (`zeekpay-bench`) |
| Deploy tx | `ec6c82ae774fc38da1b5fb9ef2b71905b318bbba2f42e674c5d284b6ae4ca439` |
| Initialize tx | `d901c34bb7843a4ed570d9864d33b461e6a71733024afc5442aaae4abd9fa302` |
| set_vk tx | `3e649c26ce0e66af285902262b0b780e412ecffa7cd8f4ab65524ab0e4a620ea` |

## Steps performed

1. `cargo build -p zeekpay --target wasm32-unknown-unknown --release` (19 KB wasm)
2. `stellar contract optimize` → 13.7 KB optimized wasm
3. `stellar contract deploy --network testnet --source zeekpay-bench`
4. `initialize(admin=zeekpay-bench, usdc_sac=XLM_SAC)` via stellar-cli
5. `set_vk(claim_vk)` via stellar-sdk Node.js script (5-element IC, 4 public inputs)
6. Wrote `.env` with all deployed addresses (gitignored)
7. Pre-seeded `backend/data/registry.json` with `@demo → zeekpay-bench` (gitignored)

## Bug fixes during e2e

### `ROOT` path in `prove.ts` and `commitment.ts`
`path.resolve(fileURLToPath(import.meta.url), "../../../../")` traversed 4 levels up
from the file — one too many, landing at the parent of the repo root.
Fixed to `"../../../"` (3 levels: file → `src/` → `backend/` → repo root).

## Verified working

- `POST /prove {"secret":"12345","recipientDigest":"42","denom":"10"}` → returns full
  Groth16 proof (proof_a 192 chars, proof_b 384 chars, proof_c 192 chars) in ~15 s
- `POST /post-root {"root":"..."}` → SUCCESS on testnet, `is_known_root` returns true
- `GET /resolve?q=@demo` → `{"found":true,"stellarAddress":"GCOM3..."}`
- Backend 33/33 tests still pass after path fix
