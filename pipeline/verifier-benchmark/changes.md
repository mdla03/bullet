# verifier-benchmark — Code (changes.md)

## Approach (deviation from spec.md — see below)
spec.md planned to deploy a verifier to testnet for the instruction number. The
environment had no rustup/wasm/CLI and the owner chose the **completely-free,
no-chain** path. So the go/no-go number is measured via **soroban-sdk's in-host
budget meter** (`cargo test`) instead of an on-chain invoke. The budget meter is
the same host-side cost model Soroban charges on-chain, so it is a faithful
measure of the dominant cost (pairings + MSM). Real testnet *fee* is deferred
(also free via Friendbot if wanted later).

## Files created / modified
- `circuits/src/preimage.circom` (new) — trivial Poseidon-preimage, 1 public
  output. Compiled `-p bls12381`. (circomlib Poseidon constants are BN254-field;
  valid arithmetic circuit, not canonical Poseidon-over-BLS — irrelevant to
  verifier cost, deferred to circom-circuit.)
- `circuits/scripts/run-benchmark.sh` (new) — compile + own Groth16 setup over
  BLS12-381 + real proof/vk generation + off-chain verify. Fully local.
- `circuits/package.json` (new) — `@zeekpay/circuits`, devDeps `circom`(binary,
  separate) `snarkjs@0.7.5` + `circomlib@2.0.5`. `bench` script.
- `pnpm-workspace.yaml` (modified) — added `circuits` as a 5th workspace member.
- `contracts/verifier/Cargo.toml` (modified) — `soroban-sdk = "=22.0.7"`
  (MSRV ok; first series with bls12_381 host fns), `testutils` dev-dep.
- `contracts/verifier/src/lib.rs` (modified) — `BenchContract::bench_verify`
  runs a Groth16-shaped check (N-pair `pairing_check` + IC `g1_msm`) using the
  native `bls12_381` host functions. -1 derived via host `fr_sub(0,1)`.
- `contracts/verifier/src/test.rs` (new) — budget measurement + cost-scaling
  table; asserts the verify fits the tx CPU limit and the canceling-pairs check
  returns true.

## Toolchain installed (all free, no fees)
- `circom` 2.2.3 binary → `~/.local/bin/circom` (macOS amd64 via Rosetta).
- `snarkjs` + `circomlib` via pnpm.
- **`rustup` + stable rust 1.96.1** — the Homebrew rust 1.83 could not satisfy a
  transitive dep (`time-core`/`zeroize` need edition2024/1.85). rustup is also
  required for the wasm32 target in the later soroban-contract feature, so this
  is not throwaway. No monetary cost.

## .gitignore updates
- `circuits/build/*.zkey`, `circuits/build/*.wtns` — regenerable proving
  artifacts.
- `**/test_snapshots/` — Soroban test snapshots.
- **`final.ptau` negation disabled** — it is 6.8M (>1MB rule) and regenerable;
  kept ignored. Policy comment left in place to re-enable for an intentional
  demo ptau. Net: only tiny public JSON (vk/proof/public/input) tracked from
  `circuits/build`.

## New dependencies (owner-approved)
- JS: `snarkjs@0.7.5`, `circomlib@2.0.5`.
- Rust: `soroban-sdk@=22.0.7` (pulls `ark-bls12-381` as the host pairing
  backend). No standalone third-party Groth16/crypto crate added — verify is
  expressed directly on host functions (route (a), as recommended/approved).

## Deviations from spec.md
1. **Measurement via host budget meter, not testnet deploy** (owner's free-only
   choice). Cost model is the same; fee number deferred.
2. **Benchmark measures verify *cost-shape*, not a byte-decoded real proof.** The
   real snarkjs proof is verified off-chain (sanity). On-chain cost is
   value-independent (full Miller loops + final exp run regardless), so the
   shape (4 pairings + IC MSM) gives the budget answer. Byte-decoding snarkjs
   vk/proof into Soroban G2 encoding is genuine soroban-contract work.

## Known gaps / TODOs
- No real proof bytes decoded on-chain yet (soroban-contract).
- Testnet fee number not collected (deferred, free when wanted).
- `circom` binary install is manual (documented); could be scripted later.
