# circom-circuit — Code (changes.md)

## Files created

### circuits/src/claim.circom (new)
Claim circuit template `Claim(20)`. Proof statement:
- `nullifier = Poseidon([secret])` (nullifier derivation; arity 1)
- `commitment = Poseidon([secret, recipientDigest, denom])` (binding; arity 3)
- `commitment` is a leaf of a depth-20 Merkle tree at `root` (opening path)

Public inputs in LOCKED order: `[root, nullifier, recipientDigest, denom]`.
Private inputs: `secret`, `pathElements[20]`, `pathIndices[20]`.

`pathIndices[i]` binary constraint: `pathIndices[i] * (1 - pathIndices[i]) === 0`.

Left/right selection for `pathIndices[i] == 0 (left) / 1 (right)` via inline
algebra — no external Mux component needed.

Uses circomlib `Poseidon` (BN254 round constants compiled over BLS12-381,
same as the benchmark). Security caveat documented in source + spec.

Measured: 11,420 total constraints (5,400 non-linear + 6,020 linear); 210
template instances; 16,961 labels.

### circuits/src/compute_hashes.circom (new)
Helper-only circuit (no equality constraints / `===`). Computes:
- `nullifier = Poseidon([secret])`
- Merkle root for a depth-20 tree with one leaf at index 0

Used by `gen-test-proof.mjs` to derive correct public-input values without
the witness calculator throwing "Assert Failed" on dummy inputs. Not part of
the ZeekPay proof system; test tooling only.

### circuits/scripts/build-claim.sh (new)
End-to-end build pipeline:
1. Compile `claim.circom` → r1cs, wasm, sym
2. Generate pot14 (2^14 = 16384 ≥ 11420 constraints) if missing
3. Groth16 setup → `claim.zkey` (gitignored)
4. Export `claim_vk.json` (tracked)
5. Run `gen-test-proof.mjs`
6. Run `convert-to-soroban.mjs` → update Soroban fixture

`pot14_final.ptau` (~27MB) is gitignored. Ceremony regenerated locally on
each fresh machine (free, offline, ~2 min).

### circuits/scripts/gen-test-proof.mjs (new)
Two-pass proof generator:
- **Pass 1:** Compile and witness-calculate `compute_hashes.circom` (no `===`
  constraints) to extract the correct `nullifier`, `root`, and zero-subtree
  `pathElements` for the test inputs (`secret=12345, recipientDigest=42,
  denom=10`, leaf at index 0).
  
  Key finding: circom optimizes away the constant signal `zeroHashes[0]=0`,
  causing a one-off shift in the `.sym` file. The sym signal `main.zeroHashes[i]`
  maps to the actual `zeroHashes[i+1]`, so `pathElements[0] = "0"` (hardcoded)
  and `pathElements[i+1] = sym["zeroHashes[i]"]` for i=0..18.
  
- **Pass 2:** Build `claim_input.json` with correct values; calculate witness;
  `snarkjs groth16 prove`; `snarkjs groth16 verify` → `OK!`.

Outputs: `circuits/build/claim_proof.json` + `claim_public.json` (tracked).

## Files modified

### circuits/scripts/convert-to-soroban.mjs
Auto-detect new filenames (`claim_vk.json`, `claim_proof.json`,
`claim_public.json`) with fallback to the benchmark names for backward
compat. Converter logic (IC/pubs iteration, G1/G2/Fr encoding) unchanged —
it is already generic for any number of public inputs.

### contracts/zeekpay/src/groth16_fixture.rs (@generated, updated)
Regenerated with the 4-input claim circuit vk + proof. IC now has 5 entries
(IC[0] + IC[1..4]); PUBS has 4 entries. The Rust test `real_proof_verifies`
uses this fixture and now validates a real claim proof through the
bls12_381 host functions.

### package.json
`build:circuits` replaced from placeholder to `bash circuits/scripts/build-claim.sh`.

### pipeline/circom-circuit/spec.md
Updated constraint count estimate from ~5,500 (estimated) to 11,420
(measured); updated ptau requirement from pot13 to pot14.

## Gitignore changes
None. Existing rules cover: `circuits/build/*.ptau`, `*.zkey`, `*.wtns`.
New tracked artifacts (`claim_vk.json`, `claim_proof.json`, `claim_public.json`,
`claim_input.json`, `groth16_soroban.json`) are JSON, <2KB each.

## Key constraint metric
```
circom claim.circom --r1cs --wasm --sym -p bls12381
  template instances: 210
  non-linear constraints: 5400
  linear constraints: 6020
  public inputs: 4
  private inputs: 41
  wires: 11444
  Total: 11420 → needs pot14 (2^14=16384)
```

## Known gap (design, not a bug)
`compute_hashes.circom` computes the Merkle root assuming leaf at index 0
with all-zero empty subtree hashes. If a future test needs a different leaf
index, the gen-test-proof script must be updated to use the correct path.
