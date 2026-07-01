# frontend-claim — Review

## Security

- `ZEEKPAY_ADMIN_KEY` is read from env at call time (never at module load).
  Must not be committed or logged. `.env.example` only has a blank placeholder.
- The `secret` sent to `POST /prove` is the ZK nullifier preimage. Privacy gap
  (same as `/commitment`): secret leaves the browser and reaches the backend.
  Production fix: run snarkjs prove in-browser with WASM served from backend.
- `POST /post-root` is admin-only (key required). No auth exposed to the public;
  503 returned cleanly if key not configured.
- `ROOT_HEX_RE` validates root is exactly 64 lowercase hex chars before any
  Stellar SDK calls.

## Correctness

- Proof encoding: `g1 = BE(X,48) || BE(Y,48)` and `g2 = BE(X_c1,48) || BE(X_c0,48) ||
  BE(Y_c1,48) || BE(Y_c0,48)` exactly matches `convert-to-soroban.mjs` and the
  Rust `G1Affine::from_bytes` / `G2Affine::from_bytes` expectations. ✓
- `pathElements[0] = "0"` hardcoded because `zeroHashes[0] = 0` is a circom
  constant and is optimized out of the witness (not in the `.sym` file); this
  matches `gen-test-proof.mjs` exactly. ✓
- Claim tx argument order matches contract signature:
  `claim(proof_a, proof_b, proof_c, root, nullifier, recipient, denom)`. ✓
- `recipient` is the connected Freighter address, already verified against
  `recipientDigest` in the "Connect Wallet" step. ✓

## Architecture

- Temp dir per-call (`os.mkdtempSync`) prevents concurrent requests from
  clobbering each other's witness / proof files.
- `fs.rmSync(tmp, { recursive: true, force: true })` in `finally` prevents
  temp file accumulation on error.
- `postRootOnChain` is a module-private async function in `resolver.ts` — no
  separate file needed for a single function.

## Known limitations (carried forward)

- Single-leaf Merkle tree only. All `pathIndices = [0,…,0]`; `pathElements[i]`
  are zero hashes. A real multi-note accumulator requires a relayer to maintain
  the tree and supply paths — deferred post-hackathon.
- `post_root` is idempotent (contract no-ops if root already known), so
  double-posting is safe.
- No `extend_ttl` on nullifier storage (pre-existing gap from soroban-contract).
