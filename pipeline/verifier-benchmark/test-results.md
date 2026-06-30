# verifier-benchmark — Test (test-results.md)

## The question
Does an on-chain Groth16 verifier fit inside Soroban's per-transaction CPU
instruction budget? Soroban network limit: **100,000,000 CPU instructions/tx**
(network-configurable; the value used for all % figures below).

## 1. Off-chain proving pipeline (real Groth16 over BLS12-381)
Command: `bash circuits/scripts/run-benchmark.sh`

Circuit compile (`circom -p bls12381`):
```
non-linear constraints: 216
public inputs: 0
private inputs: 1
public outputs: 1
```
Own Groth16 trusted setup (local ptau ceremony) → vk + proof, then off-chain
verify:
```
[INFO]  snarkJS: OK!
```
A real proof generates and verifies. Public signal (`public.json`):
```
[ "16194551325045813456199696102638278711129957240995407309199208567862169768429" ]
```
Toxic-waste note: intermediate `pot12_*.ptau` and `final.ptau` carry setup
randomness — confirmed gitignored (§4).

## 2. On-chain cost — soroban-sdk budget meter (the go/no-go number)
Command: `cargo test -p verifier -- --nocapture`
```
running 2 tests
=== Groth16-shaped verify (4 pairings + MSM-2) ===
pairing_check result : true
CPU instructions     : 70205506
memory bytes         : 447862
tx CPU limit         : 100000000
budget used          : 70.21%
test test::groth16_shape_fits_budget ... ok

=== cost scaling ===
shape                                  | CPU instructions | % of 1e8 limit
2 pairings, no MSM                     |         51199469 | 51.20%  (ok=true)
4 pairings, no MSM                     |         64697279 | 64.70%  (ok=true)
4 pairings + MSM-2 (Groth16, 1 pub in) |         70205506 | 70.21%  (ok=true)
4 pairings + MSM-8 (7 pub inputs)      |         79158015 | 79.16%  (ok=true)
test test::cost_scaling_table ... ok

test result: ok. 2 passed; 0 failed
```

### Reading the numbers
- **A Groth16 verify (4-pair pairing_check + IC MSM over 2 points = 1 public
  input) costs ~70.2M instructions = ~70% of the per-tx budget. IT FITS, with
  ~30% headroom.**
- The 4 pairings dominate (~64.7M); each public input adds ~1.5M via the MSM
  (1 pub → +5.5M over the 2-pairing baseline incl. fixed setup; 7 pub → 79%).
- `pairing_check` returns **true** for a constructed identity
  `e(P,Q)·e(-P,Q)·e(R,S)·e(-R,S)=1`, confirming the host functions behave
  correctly. -1 obtained via host `fr_sub(0,1)` (no endianness assumptions).

## 3. Adversarial / edge cases
- **More public inputs:** swept MSM up to 8 points (7 inputs) → 79%, still fits.
  ZeekPay's claim circuit targets a small public-input count, well inside budget.
- **Cost is value-independent:** pairing_check executes every Miller loop + the
  final exponentiation regardless of whether the product is the identity, so the
  measured cost is an upper-bound-faithful figure for any real proof of the same
  shape.
- **Negation correctness:** first attempt (hand-rolled big-endian `r-1` bytes)
  produced `pairing_check=false`. Replaced with host `fr_sub(0,1)` → `true`.
  Bug caught and fixed in-stage.

## 4. Toxic-waste / secrets gitignore re-verification (post-artifact)
After real ceremony artifacts existed, `git check-ignore`:
```
IGNORED circuits/build/final.ptau        (6.8M, regenerable)
IGNORED circuits/build/pot12_0001.ptau   (intermediate contribution)
IGNORED circuits/build/preimage.zkey
IGNORED contracts/verifier/test_snapshots/...
```
Tracked from `circuits/build`: only `verification_key.json`, `proof.json`,
`public.json`, `input.json` (all <5KB, public). No file >1MB in the commit set.

## What is NOT tested
- Real snarkjs proof bytes decoded + verified **on-chain** (soroban-contract).
- Real **testnet fee** in XLM (deferred; free via Friendbot when wanted).
- wasm32 contract-execution overhead on top of host-fn cost (host-test measures
  the dominant host cost; wasm glue is small relative to pairings).
- PLONK comparison (not needed — Groth16 fits; see review.md).
