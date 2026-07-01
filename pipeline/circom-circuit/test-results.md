# circom-circuit — Test (test-results.md)

## 1. Circuit compile (circom -p bls12381)

```
template instances: 210
non-linear constraints: 5400
linear constraints: 6020
public inputs: 4
private inputs: 41
public outputs: 0
wires: 11444
labels: 16961
Written successfully: circuits/build/claim.r1cs
Written successfully: circuits/build/claim.sym
Written successfully: circuits/build/claim_js/claim.wasm
Everything went okay
```

**Note:** initial spec estimated ~5,500 constraints; actual = 11,420 (circomlib
Poseidon linear wiring is larger than estimated). Updated to pot14 (2^14=16384).

## 2. R1CS info (snarkjs)

```
Curve: bls12-381
# of Wires: 11444
# of Constraints: 11420
# of Private Inputs: 41
# of Public Inputs: 4
# of Labels: 16961
# of Outputs: 0
```

## 3. Verification key (claim_vk.json)

```json
{
  "protocol": "groth16",
  "curve": "bls12381",
  "nPublic": 4,
  "IC": [5 entries]   // IC[0] + IC[1..4] for 4 public inputs
}
```

## 4. Test proof generation (gen-test-proof.mjs)

Inputs:
```
secret          = 12345
recipientDigest = 42   (small test value < BLS12-381 r)
denom           = 10   (Denom::Ten.as_u32())
pathIndices     = [0]*20  (leaf at index 0, always left child)
pathElements    = [0, Poseidon([0,0]), Poseidon([Pos([0,0]), Pos([0,0])]), ...]
```

Computed (from compute_hashes helper circuit):
```
nullifier = 30210038655452570927876935731677491109181541264348558594944850742778338046562
root      = 19148948013232879213203992136026734822699351263916619827234416357547906460635
```

snarkjs off-chain verify:
```
[INFO] snarkJS: OK!
```

Public signals (order = [root, nullifier, recipientDigest, denom]):
```json
[
  "19148948013232879213203992136026734822699351263916619827234416357547906460635",
  "30210038655452570927876935731677491109181541264348558594944850742778338046562",
  "42",
  "10"
]
```

## 5. Soroban conversion

```
wrote groth16_soroban.json + contracts/zeekpay/src/groth16_fixture.rs
ic: 5 pubs: 4 | G1 hex: 192 G2: 384 Fr: 64
```

IC=5 (correct: 4 public inputs → 5 IC points). Encoding lengths match expected
Soroban bls12_381 layout (G1=96B, G2=192B, Fr=32B hex-encoded).

## 6. Rust tests — cargo test -p zeekpay

```
running 9 tests
test test::tampered_public_input_fails ... ok
test test::wrong_public_input_count_fails ... ok
test test::claim_before_init_fails ... ok
test test::post_root_requires_admin_auth ... ok
test test::unknown_root_rejected ... ok
test test::paused_blocks_deposit_and_claim ... ok
test test::happy_path_deposit_then_claim ... ok
test test::double_spend_rejected ... ok
test test::real_proof_verifies ... ok

test result: ok. 9 passed; 0 failed
```

**`real_proof_verifies` now validates a REAL 4-public-input Groth16 claim proof
through the soroban-contract's Groth16 verifier and bls12_381 host fns.**
This is the end-to-end closure gap identified in soroban-contract/review.md.

## 7. WASM build (verify cfg(test) bypass excluded)

```
cargo build -p zeekpay --target wasm32-unknown-unknown --release
Finished `release` profile → zeekpay.wasm: 19K (unchanged)
```

## 8. Tampered-proof + wrong-count tests still pass

`tampered_public_input_fails` and `wrong_public_input_count_fails` pass
against the new fixture. The Groth16 soundness guarantee holds for the 4-input
claim circuit: a tampered public signal or wrong IC count → `false`.

## What was NOT tested here

- Proof generation in-browser (deferred to `frontend-claim`).
- `claim` with a real circuit proof on testnet (deferred to `e2e-demo`).
- `set_vk` call to replace the claim circuit vk on-chain (deferred to `e2e-demo`).
- Leaf at a non-zero Merkle index (test uses index 0 / all-left path).
- Multiple leaves in the tree (tree has exactly one deposit in the test).
