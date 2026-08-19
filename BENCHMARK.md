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
measurement, and it does **not** satisfy the SOW's requirement for a recorded
in-browser proving-time benchmark. (An earlier revision of this section said
no frontend proving harness exists — that is wrong. `prove_browser.ts` and
served circuit artifacts do exist; they were just not reachable from the
container this ran in. See §6.) Expect the same order
of magnitude in a modern browser (WASM execution, single-threaded snarkjs),
plus one-time wasm/zkey download and instantiation overhead not captured
here (~2.5 MB wasm + 7.55 MB zkey to fetch).

## 4. (b) On-chain verification cost

**Measured** (2026-08-20) on the soroban-sdk budget meter, the same method and
harness as `pipeline/verifier-benchmark/test-results.md`. The `cost_scaling_table`
test in `contracts/verifier/src/test.rs` was extended with the two shapes this
change cares about (MSM-6 and MSM-7); no new harness was written.

Command: `cd contracts && cargo test -p verifier -- --nocapture`

This measures the Groth16-verify cost shape (4 pairings + IC multi-scalar-mult)
as a function of public-input count — the same code path
`contracts/zeekpay/src/verifier.rs` uses. `bls.g1_msm` over `pubs.len()` points
is the only step whose cost scales with public-input count; `pairing_check` is
a fixed 4 pairs regardless.

| Shape | Public inputs | CPU instructions | % of 1e8 budget |
|---|---:|---:|---:|
| 2 pairings, no MSM | — | 51,199,469 | 51.20% |
| 4 pairings, no MSM | — | 64,697,279 | 64.70% |
| 4 pairings + MSM-2 | 1 | 70,205,506 | 70.21% |
| 4 pairings + MSM-6 | 5 (shape before this change) | **76,173,829** | **76.17%** |
| 4 pairings + MSM-7 | 6 (this change) | **77,665,920** | **77.67%** |
| 4 pairings + MSM-8 | 7 | 79,158,015 | 79.16% |

**Marginal cost of `amountCommitment`: +1,492,091 instructions (+1.49% of
budget), measured.** The 6-input circuit verifies at 77.67% of the per-tx
limit, leaving ~22% headroom. Fits.

Note on the earlier estimate: a prior revision of this report extrapolated
these figures by linear fit and published ≈76.81% / ≈78.35% with a marginal
cost of ≈1,537,716. The measured values come in slightly **below** that, so
the extrapolation was conservative — it overstated cost by ~0.65 percentage
points at both shapes, and overstated the per-input marginal by ~3%. The
measured numbers above supersede it. The go/no-go conclusion is unchanged.

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

## 6. Not run

- `cargo test -p zeekpay` — not run. No file under `contracts/zeekpay/` was
  modified, so existing contract tests are unaffected; this is by inspection,
  not re-execution.
- Real testnet deploy/invoke of the extended verifier — the deployed
  contract's `derive_public_inputs` is locked at 5 inputs and out of scope
  to change, so there is nothing to deploy against for a 6-input proof.
- **In-browser proving time is still outstanding.** §3's figures are Node CLI,
  not browser. Contrary to §3's earlier caveat, a browser proving path does
  exist (`frontend/src/lib/prove_browser.ts`, snarkjs 0.7.5 in
  `frontend/package.json`, artifacts served from `frontend/public/circuits/`);
  it was simply not reachable from the container this ran in. Note the served
  `claim.wasm` / `claim.zkey` there are still the **5-input** build, so
  measuring the new circuit in-browser requires shipping the new artifacts
  first. The SOW lists a recorded in-browser proving-time benchmark as
  required D1 evidence, so this remains an open gap.

---

**Stopping here per task instructions — not proceeding to any further
deliverable.**
