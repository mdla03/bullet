# verifier-benchmark — Plan (spec.md)

## What & why
Pre-product gate 2 + the single biggest project risk: **does a Groth16 verifier
fit inside Soroban's per-transaction instruction budget at an acceptable fee?**
Maps to SPEC.md §4 pre-product gates. **Hard stop after this for owner go/no-go
on the proof system.** Everything downstream depends on the answer.

This feature builds the *minimum* needed to get a real on-chain number — not
product code. No deposit/claim, no nullifiers, no real notes.

## The decision this benchmark drives
Verdict in `review.md` must be one of:
1. **GO — Groth16 on-chain.** Verifier fits with comfortable margin.
2. **NO-GO → PLONK on-chain.** If PLONK verify fits where Groth16 doesn't.
3. **NO-GO → off-chain verify + on-chain attestation.** Verify off-chain, post a
   signed/threshold attestation the contract trusts. (Weaker trust model —
   documented.)
Per amended SPEC §4, the fallback becomes **part of P0**, not roadmap.

## Curve choice — the core variable (VERIFY IN CODE STAGE)
Groth16 verification cost on-chain is dominated by **elliptic-curve pairings**
(typically 3 pairings / a multi-pairing) + one MSM over public inputs. Cost
hinges entirely on whether Soroban exposes **native host functions** for the
curve:

- **BLS12-381:** recent Soroban host versions expose a `bls12_381` module
  (G1/G2 add & mul, MSM, pairing, map-to-curve). If present, a Groth16 verifier
  over BLS12-381 calls host functions → cheap, fits budget. **Hypothesis:
  recommended path.**
- **BN254 / alt_bn128:** circom/snarkjs default curve, best browser-proving
  tooling — but **no native Soroban host functions** (to confirm). Verifier
  would run pairing arithmetic in pure wasm → expected to blow the instruction
  budget.

**Action in Code stage:** confirm against the *installed* `soroban-sdk` /
Soroban CLI / testnet protocol version which curve host functions actually
exist, and at what version. Do not assume from memory. Pick the curve from what
testnet actually supports today.

### Known tension (flag, don't resolve here)
- Browser proving tooling (snarkjs, circomlib Poseidon constants) is most mature
  on **BN254**. On-chain verify is cheapest on **BLS12-381** (if host fns exist).
  The product may prove on BLS12-381 too — circom supports `-p bls12381`. The
  benchmark measures the **on-chain verify** cost; proving-side ergonomics are a
  `circom-circuit` concern, noted not solved here.
- circomlib's Poseidon constants are **BN254-field specific**. A BLS12-381
  circuit needs Poseidon params over the BLS scalar field (or a different hash).
  **Irrelevant to verifier budget** (verifier cost is pairings + public-input
  count, ~independent of in-circuit hash), so the benchmark uses the simplest
  valid circuit. The hash-params question is deferred to `circom-circuit`.

## What gets built (minimal)
1. **Circuit** (`circuits/src/preimage.circom`): trivial Poseidon preimage —
   prove knowledge of `secret` s.t. `hash == Poseidon(secret)`, with `hash` the
   single public input. Smallest thing that yields a real Groth16 proof with one
   public input.
2. **snarkjs harness** (`circuits/scripts/`): compile, Groth16 trusted setup
   (own ceremony — local ptau), export `verification_key.json`, generate a
   proof + public signals, export proof/vk in the byte layout the contract reads.
3. **Soroban verifier contract** (`contracts/verifier/`): a single
   `verify(proof, vk, public_inputs) -> bool` entry that runs the Groth16 check
   using the chosen curve's host functions. Hardcode/embed the vk for the
   benchmark; no storage, no business logic.
4. **Measurement harness** (`scripts/` or `circuits/scripts/`): invoke `verify`
   on testnet (and/or via simulation) and capture instruction count, resource
   fees, and budget %.

## Public interface (benchmark contract)
```
fn verify(env, proof: Bytes, public_inputs: Vec<...>) -> bool
```
Exact arg encoding (proof a/b/c points, vk layout) finalized in Code stage once
the curve + host-fn signatures are confirmed.

## Files created / modified
- `circuits/src/preimage.circom` (new)
- `circuits/scripts/{compile,setup,prove,export}.{sh,js}` (new)
- `circuits/package.json` (new — adds `circomlib`, `snarkjs`; see deps below)
- `contracts/verifier/Cargo.toml` (modified — add `soroban-sdk`, `#![no_std]`)
- `contracts/verifier/src/lib.rs` (modified — verify entry)
- `scripts/bench-verifier.*` (new — testnet measurement)
- `circuits/build/*` generated (gitignored except final.ptau / vk / wasm / zkey)

## What gets measured (test-results.md targets)
- Instructions consumed by one `verify` call.
- **% of Soroban per-tx instruction budget.**
- Resource fee per verify (stroops + approx XLM), on **testnet**.
- Proof size / vk size (informational).
- Browser proving time for the trivial circuit (informational sanity check).

## Security-sensitive assumptions (CALLED OUT)
- **Trusted setup = toxic waste.** The Groth16 phase-2 ceremony produces
  intermediate `ptau` contributions containing private randomness. These **must
  be gitignored** (`*.ptau` except `final.ptau`, `*_contribution_*`,
  `contributions/`). The scaffold `.gitignore` already covers this — Test stage
  re-verifies after artifacts are generated. README/this review state plainly:
  own (non-MPC) setup, demo-only trust assumption.
- This benchmark does **not** implement nullifiers, double-spend protection, or
  recipient binding — explicitly out of scope; do not let it look production-ready.
- The verifier's soundness is only as good as the host-function pairing impl +
  our vk handling. Note any place a malformed proof/vk could panic vs return false.

## New dependencies (ASK before install — heavy/crypto)
- `snarkjs`, `circomlib` (JS, circuit tooling) — needed, please confirm.
- `circom` compiler — needed (binary; install method confirmed in Code stage).
- On the Rust side: a Groth16-over-host-functions verifier. **Two routes:**
  (a) hand-write the pairing check calling Soroban `bls12_381` host fns (no extra
  crate), or (b) pull a Groth16 verifier crate compatible with Soroban.
  **Recommend (a)** — fewer deps, no unaudited crypto crate in the trust path.
  Will not add any Rust crypto crate without your OK.

## Open questions for owner
1. **OK to install `snarkjs` + `circomlib` + `circom`?** (Required to produce any
   proof at all.)
2. **Verifier route (a) hand-rolled host-fn pairing vs (b) a crate** — I
   recommend (a). Agree?
3. **Testnet measurement:** I need a funded testnet account (Friendbot) +
   Soroban RPC URL. OK to generate a throwaway testnet key (gitignored, never
   the deployer key in `.env`) and fund via Friendbot? Or will you provide one?
4. If the installed Soroban testnet protocol has **no** usable curve host
   functions at all, do you want me to (i) still benchmark a pure-wasm verifier
   to get the "how bad" number, or (ii) jump straight to the off-chain-attestation
   plan? Recommend (i) — one real number makes the go/no-go defensible.

No code until you OK this spec + answer Q1–Q4.
