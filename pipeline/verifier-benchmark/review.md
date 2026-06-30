# verifier-benchmark — Review (review.md)

## VERDICT: GO — Groth16 on-chain via Soroban `bls12_381` host functions

A Groth16 verify (4-pair `pairing_check` + IC MSM, 1 public input) costs
**~70.2M / 100M CPU instructions (~70%, ~30% headroom)**, and the native host
functions are confirmed working (pairing identity verifies `true`). No need for
the PLONK / off-chain-attestation fallbacks. **Proof system for ZeekPay:
Groth16 over BLS12-381.**

### Why not the fallbacks
- **PLONK on-chain:** unnecessary — Groth16 fits. PLONK verify is generally
  heavier (more pairings/MSM), would eat more budget.
- **Off-chain verify + attestation:** weaker trust model; only justified if
  on-chain didn't fit. It does. Keep verification trustless on-chain.

## Confidence / caveats (honest)
- **Measured via host budget meter, not a testnet invoke.** Same host cost
  model, so the instruction figure is faithful; but the real tx also pays for
  wasm execution of the contract glue + I/O marshalling. That overhead is small
  next to 4 pairings, but the *true* on-chain number will be somewhat **above**
  70%. **Headroom is ~30% — comfortable but not huge.** Recommend confirming
  with a real testnet deploy before the contract is finalized (free via
  Friendbot). Until then, treat 70% as a lower bound.
- **Cost-shape, not byte-decoded proof.** On-chain cost is value-independent, so
  this is valid for go/no-go. Decoding snarkjs vk/proof into Soroban's G1/G2
  byte encoding (esp. G2 Fp2 component order) is unfinished and is real
  soroban-contract risk — call it out there and test the first real on-chain
  verify against a known-good snarkjs proof.

## Security checklist
| Item | Status |
|------|--------|
| Trusted-setup toxic waste gitignored | ✓ `*.ptau` (incl. final.ptau, 6.8M), `*_contribution_*`, `contributions/`, `*.zkey` all IGNORED; re-verified post-generation |
| Secrets in diff | ✓ none — bench uses throwaway entropy, no keys committed |
| Files >1MB | ✓ none tracked (final.ptau ignored) |
| Nullifier / double-spend | n/a — out of scope for benchmark (NOT implemented; do not mistake for product) |
| Recipient binding / public-input layout | deferred to circom-circuit; benchmark used a placeholder shape |
| Verifier soundness | depends on host pairing impl (ark-bls12-381, audited) + our own (non-MPC) Groth16 setup — README states this |

## Code quality
- `bench_verify` is benchmark-only; clearly documented as not-product. Should be
  **replaced**, not extended, by the real verifier in soroban-contract.
- `-1` via host `fr_sub` (clean) after the hand-rolled byte version misbehaved —
  good lesson: don't hand-encode field elements when the host offers arithmetic.
- circom Poseidon-over-BLS caveat documented in the circuit file.

## README accuracy
README already states own-Groth16-setup + future MPC, fixed-denom, honest
privacy. No change needed from this feature. The proof-system decision (Groth16
/ BLS12-381) should be recorded in SPEC §6 / README when the owner confirms GO.

## Recommended follow-ups (NOT built)
1. **soroban-contract:** real verifier decoding snarkjs vk/proof bytes; test the
   first on-chain verify against a known snarkjs proof (catches G2 encoding).
2. One **free testnet deploy** to confirm the real fee + true budget % with wasm
   overhead included, before locking the design.
3. Pin/automate the `circom` binary install in the bench script.
4. Keep public-input count small in the claim circuit (each adds ~1.5M).

## Owner decision required (HARD STOP)
Confirm **GO: Groth16 over BLS12-381** as ZeekPay's proof system. On confirmation
I record it in SPEC/README and proceed to `soroban-contract`. If you'd rather I
collect the real testnet number first (free) before committing, say so.
