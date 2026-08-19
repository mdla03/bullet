# Benchmark report: amount commitment + range proof (claim.circom)

**Date:** 2026-08-18
**Scope:** extends `circuits/src/claim.circom` with a Poseidon-based amount
commitment (`amountCommitment = Poseidon([amount, blinding])`) and an
in-circuit range proof (`amount < 2^64`). Full design rationale and the
required scope overrides (this is P3 per top-level `SPEC.md`, built on an
explicit written project-owner override) are documented in the
`claim.circom` header comment and in `pipeline/circom-circuit/spec.md` /
`review.md`'s 2026-08-18 addenda. This report is numbers only.

**Read this first — what this does and doesn't do:** `amount` remains a
plaintext public input (the Soroban contract needs it in the clear for the
token transfer, and the contract was out of scope for this change). The new
commitment and range proof do **not** hide the amount on-chain today. They
are a defense-in-depth integrity binding, not amount privacy. Do not cite
this report as evidence of amount privacy.

---

## 1. Circuit shape

| | Before (5 public inputs) | After (6 public inputs) | Delta |
|---|---:|---:|---:|
| Public inputs | 5 | 6 | +1 (`amountCommitment`) |
| Private inputs | 41 | 42 | +1 (`blinding`) |
| Non-linear constraints | 5,400 | 5,743 | +343 |
| Linear constraints | 6,020 | 6,390 | +370 |
| **Total constraints** | **11,420** | **12,133** | **+713 (+6.2%)** |
| Wires | 11,444 | 12,158 | +714 |
| Template instances | 210 | 215 | +5 |

Still well within pot14 (2^14 = 16,384 ≥ 12,133). Compiled with
`circom 2.2.3 --r1cs --wasm --sym -p bls12381`, clean (no errors/warnings).

## 2. Build artifacts

Fresh local trusted setup (no ptau existed in this checkout; none of it is
committed — only `claim_vk.json` and `claim.zkey` are tracked, per
`circuits/.gitignore`):

| Artifact | Size |
|---|---:|
| `pot14_final.ptau` (gitignored, regenerated) | 28.3 MB |
| `claim.zkey` (tracked) | 7.55 MB (was ~7.26 MB before this change) |
| `claim_js/claim.wasm` (tracked) | 2.49 MB |
| `claim_vk.json` (tracked) | 5.4 KB |

`circuits/scripts/convert-to-soroban.mjs` was **not run** — it overwrites
`contracts/zeekpay/src/groth16_fixture.rs`, which is out of scope for this
change (contract untouched). Ran the equivalent of `build-claim.sh`'s steps
1–5 manually to avoid step 6.

## 3. (a) Proving time

Measured with the Node.js `snarkjs` CLI on this machine (witness calculation
+ `groth16 prove`), 3 runs:

| Run | Witness calc | Groth16 prove | Total |
|---|---:|---:|---:|
| 1 | 166 ms | 1,776 ms | 1,943 ms |
| 2 | 128 ms | 1,607 ms | 1,735 ms |
| 3 | 127 ms | 1,602 ms | 1,730 ms |

**Caveat:** this is a Node.js CLI proxy, not a literal in-browser
measurement. In-browser snarkjs integration is explicitly not built yet
(`pipeline/circom-circuit/spec.md`, "Not built in this feature"); no
frontend proving harness exists to measure against. Expect the same order
of magnitude in a modern browser (WASM execution, single-threaded snarkjs),
plus one-time wasm/zkey download and instantiation overhead not captured
here (~2.5 MB wasm + 7.55 MB zkey to fetch).

## 4. (b) On-chain verification cost

**Could not be measured directly in this environment** — no `cargo`/`rustc`
toolchain is available here, and re-measuring for real would require
running the (out-of-scope) `contracts/zeekpay` contract or the
benchmark-only `contracts/verifier` crate, neither of which I ran.

Instead, extrapolated from the project's own real, **testnet-confirmed**
cost-scaling data (`pipeline/verifier-benchmark/test-results.md`), which
measures Groth16-verify cost shape (4 pairings + IC multi-scalar-mult) as a
function of public-input count on Soroban's CPU budget meter — the same
code path `contracts/zeekpay/src/verifier.rs` uses (`bls.g1_msm` over
`pubs.len()` points is the only step whose cost scales with public-input
count; `pairing_check` is a fixed 4 pairs regardless):

| Public inputs (IC size) | CPU instructions (real, testnet) | % of 1e8 budget |
|---:|---:|---:|
| 1 (IC=2) | 70,662,026 | 70.66% |
| 7 (IC=8) | 79,888,324 | 79.89% |

Linear fit between these two real points: **≈1,537,716 instructions per
additional public input**, consistent with the project's own prior note
("each public input adds ~1.5M via the MSM").

Extrapolated (not measured) for this circuit:

| Public inputs | Extrapolated CPU instructions | % of 1e8 budget |
|---:|---:|---:|
| 5 (current production shape) | ≈76,812,891 | ≈76.81% |
| 6 (this change, +`amountCommitment`) | ≈78,350,608 | ≈78.35% |

**Marginal cost of `amountCommitment`: ≈+1.54M instructions (≈+1.54% of
budget).** Both extrapolated figures stay under the 100M per-tx limit with
>20% headroom, consistent with the real MSM-8/7-pub-input testnet
measurement (79.89%) sitting close by as a sanity check. This is an
extrapolation from real data, not a fresh on-chain measurement — treat the
absolute % as approximate.

## 5. Test vectors

All run against the freshly-generated `claim.zkey`/`claim_vk.json` for the
extended circuit.

| Case | Mechanism | Result |
|---|---|---|
| Valid proof (secret=12345, recipientDigest=42, amount=10, tokenId=0, blinding=999999) | `snarkjs groth16 verify` | **OK** — verifies true |
| Tampered `amountCommitment` (last public signal +1) | same proof, mutated `claim_public.json`, `snarkjs groth16 verify` | **Invalid proof** — verify returns false, as required |
| Out-of-range amount (`amount = 2^64`, self-consistent commitment/root recomputed via `compute_hashes.circom` so only the range check is exercised) | `snarkjs wtns calculate` | **Assert Failed** in the `Num2Bits` component — no witness, so no proof can even be constructed |
| Boundary amount (`amount = 2^64 - 1`) | full witness → prove → verify | **OK** — valid proof, verifies true (confirms the bound isn't off-by-one) |

Note on the out-of-range case: it fails at witness-generation time, not at
`verify()` time, which is a stronger guarantee than the tampered-commitment
case — an out-of-range amount cannot produce a valid proof at all, whereas a
tampered public input merely fails the check on an otherwise-valid proof.
An earlier attempt that changed only `amount` in the original `claim_input.json`
without recomputing the dependent Merkle commitment/root failed too, but for
the wrong reason (root mismatch, not the range check) — the reported result
above uses the isolated version via `compute_hashes.circom` to attribute the
failure correctly to the range constraint.

## 6. Not run / not verifiable in this environment

- `cargo test -p zeekpay` — no Rust toolchain available here. Not needed for
  correctness of this change since no file under `contracts/` was modified;
  existing contract tests are unaffected by inspection, not re-execution.
- Real testnet deploy/invoke of the extended verifier — the deployed
  contract's `derive_public_inputs` is locked at 5 inputs and out of scope
  to change, so there is nothing to deploy against for a 6-input proof.

---

**Stopping here per task instructions — not proceeding to any further
deliverable.**
