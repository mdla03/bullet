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

## Deliverable 1 go/no-go decision: GO

**Update 2026-09-08:** the commitment has since been replaced by a Pedersen commitment on Jubjub, closing the deviation noted below. Numbers for that shape are in section 7. This section is kept as the dated record of the 2026-08-20 decision.

**Decided 2026-08-20 by Mark Aquino (builder).**

The SOW makes Deliverable 1 a gate: in-browser proving time and on-chain
verification cost are benchmarked in week one as a go/no-go checkpoint before
the rest of the sprint proceeds (SOW section 4.1). Both numbers are now
measured rather than estimated, and both pass with margin.

| Gate metric | Result | Margin |
|---|---|---|
| On-chain verification cost, 6 public inputs | 77,665,920 CPU instructions, 77.67% of the 100,000,000 per-transaction budget | ~22% headroom |
| In-browser proving time | 1,349 ms median over 25 runs, headless Chrome 151 | cold run 1,642 ms |

Method and raw numbers are in sections 3 and 4 below. The on-chain figure comes
from the soroban-sdk budget meter via `cargo test -p verifier`. The in-browser
figure comes from a real browser executing the real circuit wasm, driven by
`frontend/scripts/bench-browser.mjs`, and each run verifies its own proof, so a
timing can never be recorded for an invalid proof.

**Verdict: proceed.** Neither metric is close to a limit.

### What this decision does not assert

- **It is not a privacy claim.** `amount` is still a plaintext public input.
  See the note above. The commitment and range proof are an integrity binding.
- **It is not a security sign-off.** No external audit has been done, and the
  SOW lists one as a mainnet prerequisite (out-of-scope item 4). The trusted
  setup is a single local contribution, not a multi-party ceremony
  (out-of-scope item 3).
- **The commitment is Poseidon, not Pedersen.** The SOW specifies Pedersen.
  circomlib's Pedersen uses Baby Jubjub, which is a sound group only over the
  BN254 scalar field, while this circuit compiles under BLS12-381. A
  single-proof design does not need the additive homomorphism Pedersen would
  provide, so Poseidon is the correct primitive here rather than a fallback.
  Recorded as a deviation from the SOW text.

### Found and fixed while benchmarking

A security review of this work surfaced a pre-existing contract bug, unrelated
to the circuit change. `derive_public_inputs` truncated the amount via
`amount as u64` while `token::Client::transfer` moved the full `i128`, so a
proof for X also authorised a transfer of 2^64 + X, capped by the pool balance.
Fixed by `AMOUNT_MAX_EXCLUSIVE` in `contracts/zeekpay/src/lib.rs` and pinned by
regression tests that were confirmed to fail without the fix. The fix is on
master and **not yet deployed to testnet**.

A second finding remains open: deposits are not bound to their commitments, so
a one-stroop deposit can claim a larger amount. No contract guard closes that,
because the contract cannot inspect a hash over a secret it does not know. The
fix is the in-circuit balance constraint of the shielded-pool join-split, which
is built and tested in `circuits/src/joinsplit.circom`.

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

### 3.1 In-browser (2026-08-20) — the SOW's required measurement

Real browser, real circuit wasm. Headless Chrome 151 on macOS, driven by
`frontend/scripts/bench-browser.mjs` against the `/bench` page, which calls
`snarkjs.groth16.fullProve` exactly as `src/lib/prove_browser.ts` does.

Command (dev server running, artifacts staged per §2 of that script's header):

```
node frontend/scripts/bench-browser.mjs 25
```

| Sweep | Cold run | Median, all runs | Median, excluding cold |
|---|---:|---:|---:|
| 25 runs | 1,642 ms | **1,349 ms** | 1,349 ms |
| 7 runs | 1,550 ms | 1,364 ms | 1,358 ms |

Spread across the 25-run sweep was 1,298–1,642 ms. The cold run carries
one-time wasm instantiation and costs roughly 200–300 ms extra; every run
after it sits in a tight band.

**Each sweep verifies its own last proof.** `groth16.verify` returned true
with 6 public signals, so these timings are not measuring a prover that
emits garbage quickly. The script exits non-zero if verification fails or
the public-signal count is not 6.

Asset load (fetch + decode of 2.61 MB wasm + 7.92 MB zkey) measured 77–92 ms,
but that is from localhost and is a floor, not a real-world figure. Over a
real network this phase is dominated by the ~10.5 MB download and will
dwarf the proving time itself on a slow connection. That download is the
number to care about for claim UX, not the 1.35 s of proving.

### 3.2 Node.js CLI, for comparison

Node `snarkjs` CLI (witness calculation + `groth16 prove`), 3 runs:

| Run | Witness calc | Groth16 prove | Total |
|---|---:|---:|---:|
| 1 | 166 ms | 1,776 ms | 1,943 ms |
| 2 | 128 ms | 1,607 ms | 1,735 ms |
| 3 | 127 ms | 1,602 ms | 1,730 ms |

The browser is **faster** than the Node CLI here (1.35 s vs ~1.73 s), so the
earlier assumption that browser proving would be slower did not hold. Most of
the CLI's extra time is process startup and file I/O per invocation, which the
in-page loop does once.

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
- Nothing outstanding on the benchmark side. Both SOW-required numbers,
  in-browser proving time (§3.1) and on-chain verification cost (§4), are now
  measured rather than estimated.
- The artifacts served at `frontend/public/circuits/claim.{wasm,zkey}` are
  still the **5-input** build, and deliberately so: the deployed contract
  pushes 5 `Fr`s and `verifier::verify` rejects a vk whose IC length does not
  match. The benchmark reads its own copies from
  `frontend/public/circuits/bench/` instead. Swapping the production artifacts
  is part of the D2 handoff, not this change.

---

**Sections 1 to 6 above are the closed 2026-08-20 record of the Poseidon shape.
Section 7 below supersedes them for the shape that actually ships.**

## 7. Pedersen shape (2026-09-08)

**Scope:** `circuits/src/claim.circom` at dev commit 97ce901. The amount commitment is now C = amount * G + blinding * H on Jubjub, the BLS12-381 embedded curve, as the SOW specifies. The commitment leaves the circuit as two public inputs, `amountCommitmentX` and `amountCommitmentY`. The 64-bit range proof on `amount` is unchanged. G is the Jubjub generator and H is Zcash's value-commitment randomness base, both derived by `circuits/scripts/jubjub-ref.mjs` and cross-checked in `circuits/test/jubjub.test.mjs` (21 tests).

### 7.1 Circuit shape

| | Poseidon (section 1) | Pedersen on Jubjub | Delta |
|---|---:|---:|---:|
| Public inputs | 6 | 7 | +1 |
| Private inputs | 42 | 42 | 0 |
| Non-linear constraints | 5,743 | 10,422 | +4,679 |
| Total constraints | 12,133 | 16,768 | +4,635 (+38.2%) |
| Powers of tau | pot14 | pot15 | ceiling 16,384 exceeded |

PedersenCommit alone is 5,152 constraints (4,922 non-linear): a 64-bit fixed-base multiply on G, a 251-bit fixed-base multiply on H, one point add.

### 7.2 On-chain verification cost, real proof

Method: `contracts/verifier` test `real_7in_claim_proof_verify_cost` runs the verify equation from `contracts/zeekpay/src/verifier.rs` on the real verification key and proof from `circuits/build/` (fixture `contracts/verifier/src/claim_fixture_7in.rs`) under the soroban-sdk budget meter. The proof verifies `true`.

| Metric | Value |
|---|---:|
| CPU instructions | 53,972,600 |
| Share of the 100,000,000 per-transaction budget | 53.97% |
| Headroom | 46.03% |
| Memory bytes | 431,063 |

Two notes on reading this number.

- It is lower than the 6-input figure of 77,665,920 in section 4, and lower than the synthetic scaling table's 7-input row (79,158,015). The synthetic `bench_verify` builds its test points with four hash-to-curve calls, which a real verify never performs; a real verify decodes points from bytes. The synthetic rows therefore overstate real verify cost by roughly 25M instructions. The real-proof measurement is the trustworthy one.
- It isolates the verify equation. A full claim transaction adds the token transfer, storage reads and writes, and wasm instantiation. The first real testnet claim, with 4 public inputs, measured 70.66% for the whole transaction. The on-chain gate number is confirmed by a real testnet claim once the contract takes 7 inputs (week 2).

### 7.3 In-browser proving time

Method as in section 3.1: 25 runs through `frontend/scripts/bench-browser.mjs`, headless Chrome 152 on Windows, each run verifies its own proof, 7 public signals observed.

| Metric | Value |
|---|---:|
| Median | 675 ms |
| Mean | 678.5 ms |
| Min | 648 ms |
| Max | 783 ms |
| Cold (first run) | 783 ms |
| Artifacts fetched | 2.73 MB wasm + 12.42 MB zkey = 15.15 MB |

Section 3.1's 1,349 ms median was measured on a different machine (macOS, Chrome 151). The two runs are not an A/B and should not be read as Pedersen proving faster than Poseidon. A same-machine comparison is optional; both are far from any limit.

### 7.4 Test vectors

Section 5's table is the Poseidon-shape record and does not apply to this circuit: it lists 6 public signals and a single `amountCommitment`. The vectors below are the Pedersen-shape replacements, all regenerated against the current `claim.zkey`/`claim_vk.json`.

| Case | Mechanism | Result |
|---|---|---|
| Valid proof (secret=12345, recipientDigest=42, amount=10, tokenId=0, blinding=999999) | `snarkjs groth16 verify` | **OK**, verifies true |
| Boundary amount (`amount = 2^64 - 1`) | full witness → prove → verify | **OK**, valid proof, verifies true, so the bound is not off by one |
| Out-of-range amount (`amount = 2^64`, with the Merkle root and Pedersen commitment recomputed for that amount so only the range is wrong) | `snarkjs wtns calculate` | **Assert Failed** in `Num2Bits`, no witness, so no proof can be constructed |
| Tampered commitment x (`amountCommitmentX + 1`, public signal index 5) | same proof, mutated public signals, `snarkjs.groth16.verify()` | **Invalid proof**, verify returns false |
| Tampered commitment y (`amountCommitmentY + 1`, public signal index 6) | same proof, mutated public signals, `snarkjs.groth16.verify()` | **Invalid proof**, verify returns false |

`circuits/scripts/gen-test-proof.mjs` writes all five and asserts each outcome as it goes, including that the out-of-range failure is in `Num2Bits` and not somewhere else.

The two tampered vectors are checked with snarkjs as a library, asserting `groth16.verify()` returns literally `false`. The CLI was used before, and its non-zero exit meant only "something went wrong": a stale vk path or a typo'd argument satisfied the check just as well as a rejected proof did. The script also verifies the untampered signals return `true` on the same vk and the same proof object first, so a `false` cannot come from a broken harness. A vector that started passing for the wrong reason fails the script rather than being committed. This matters because the previous hand-written vectors went stale in the Pedersen swap: the committed boundary proof stopped verifying against `claim_vk.json` and nothing noticed, since nothing regenerated or re-checked them.

The circuit's 64-bit bound and the contract's `AMOUNT_MAX_EXCLUSIVE = 1i128 << 64` are the two halves of one mechanism and are equal, as the `claim.circom` header requires.

### 7.5 Reproducing these numbers

```
cd circuits && npm install
npm test                                    # 24 Jubjub/Pedersen cross-checks
node scripts/jubjub-ref.mjs                 # generator + Montgomery constants, self-check
node scripts/gen-test-proof.mjs             # the five vectors in 7.4
cd ../contracts && cargo test -p verifier real_7in_claim_proof_verify_cost -- --nocapture
```

`npm test` compiles the harness circuits in `circuits/test/` first (`scripts/build-jubjub-tests.sh`); they are gitignored, so a fresh clone has to build them. Both need `circom` for BLS12-381, found at `$CIRCOM` or `~/.local/bin/circom`. The random inputs in `jubjub.test.mjs` come from a seeded generator and the seed is printed on every run: re-run with `JUBJUB_SEED=<seed>` to replay a failure exactly.

The `bench_verify_real` path used above is behind the `real-proof` cargo feature (off by default, so the default `verifier` wasm build does not export `zeekpay`'s product contract ABI); `contracts/verifier/Cargo.toml` enables it automatically for the test target via a self dev-dependency, so no extra `--features` flag is needed for the command above.

### 7.6 Gate verdict for the Pedersen shape

Both gate metrics are inside their limits with margin on the same criteria as the 2026-08-20 decision: verify cost 53.97% of budget with the real proof, proving time under one second. **Proceed.** The SOW deviation recorded in the go/no-go section (Poseidon instead of Pedersen) is closed.

Open items: confirm the on-chain number with a testnet claim after the contract moves to 7 public inputs; the standalone range proof in `claim.circom` duplicates the 64-bit decomposition inside PedersenCommit and is kept deliberately (see the `ponytail:` note in the circuit).
