# circom-circuit — Plan (spec.md)

## Goal

Build the real ZeekPay claim circuit in Circom. Produce WASM + proving key so
the frontend can generate Groth16/BLS12-381 proofs in-browser, and produce
`verification_key.json` so the soroban-contract `set_vk` call can be updated
with the real 4-input vk. Close the gap flagged in soroban-contract review:
end-to-end claim with a real matching proof.

---

## Proof statement

> "I know a `secret` such that:
> 1. `Poseidon([secret]) == nullifier` (public)
> 2. `commitment = Poseidon([secret, recipientDigest, denom])` (internal)
> 3. `commitment` is a leaf of a Merkle tree of depth 20 whose root is `root` (public)
>
> and I know the Merkle opening path for that leaf."

This is a standard Tornado-Cash-style membership+nullifier circuit adapted to
BLS12-381 and the soroban-contract's LOCKED public-input interface.

---

## Public inputs (LOCKED — must match `derive_public_inputs` in `contracts/zeekpay/src/lib.rs` exactly)

| # | circom signal | soroban-contract derivation | Notes |
|---|---------------|-----------------------------|-------|
| 0 | `root` | `Fr(root)` | Merkle root (32-byte BE Fr) |
| 1 | `nullifier` | `Fr(nullifier)` | Poseidon([secret]) |
| 2 | `recipientDigest` | `recipient_fr(env, recipient)` = sha256(recipient.to_xdr) top-byte-zeroed | Recipient binding |
| 3 | `denom` | `Fr(denom.as_u32())` = 1/10/50/100 | Denom binding |

Order matters — snarkjs assigns public-input indices by declaration order in `component main = Claim() {public [...]}`.

---

## Private inputs

| signal | type | meaning |
|--------|------|---------|
| `secret` | Fr | Note secret. Prover only. How the recipient obtains it: key derivation from Freighter signature (x-oauth-identity feature, not built yet). |
| `pathElements[DEPTH]` | Fr[20] | Merkle proof sibling hashes |
| `pathIndices[DEPTH]` | bit[20] | 0 = current node is left child, 1 = right |

---

## Internal signals

```
nullifierCheck = Poseidon([secret])
commitment     = Poseidon([secret, recipientDigest, denom])
computed_root  = MerkleProof(commitment, pathElements, pathIndices)
```

Constraints:
- `nullifierCheck === nullifier`
- `computed_root === root`

The `recipientDigest` and `denom` public inputs are already wired into
`commitment`, so they are inherently constrained. No extra equality checks
needed for them.

---

## Security rationale for commitment preimage

**`recipientDigest` MUST be in commitment preimage.**
If commitment = Poseidon([secret]) only, an attacker who sees a claim tx in the
mempool can extract `secret`, build a new proof binding the attacker's
`recipientDigest`, and front-run the claim. Including `recipientDigest` in the
preimage makes the commitment recipient-specific; a front-runner without the
correct recipient cannot produce a matching commitment.

**`denom` MUST be in commitment preimage.**
Without it, a 1-USDC note's proof could be replayed for a 100-USDC claim (same
secret, different denom public input). Including `denom` binds the denomination
to the commitment.

**Nullifier domain separation.**
`nullifier = Poseidon([secret])` (arity 1) vs `commitment = Poseidon([secret,
recipientDigest, denom])` (arity 3). Different arity = different Poseidon
permutation → they cannot collide.

---

## Merkle hasher

```circom
// per-level node hash
node = Poseidon([left, right])
```

Left/right ordering: `pathIndices[i] == 0` → current node is the left child,
`pathElements[i]` is the right sibling; `pathIndices[i] == 1` → current is
right, sibling is left.

Use circomlib `MerkleProof` component (already in circomlib) or inline a simple
`for` loop with `Poseidon(2)` + `MultiMux1` selector. The circomlib
`MerkleProofVerifier` / `CheckRoot` / `MerkleTreeCheckerPoseidon` variants vary
by version — code stage will pick the right one after checking the circomlib
version installed.

---

## Tree parameters

| Constant | Value | Rationale |
|----------|-------|-----------|
| `DEPTH` | 20 | Supports 2^20 ≈ 1M deposits (same as Tornado Cash). At ~5K constraints total, in-browser proof time stays well under 5s. |

Measured constraint count (circom output):
- non-linear constraints: 5400; linear constraints: 6020
- Total: **11,420 constraints** → needs pot14 (2^14 = 16384 ≥ 11420)
- Note: circomlib Poseidon internal wiring adds more linear constraints than
  the raw non-linear estimate. pot13 (8192) is insufficient.

---

## Poseidon note (security caveat)

Using circomlib `Poseidon` with BN254 round constants, compiled with
`-p bls12381`. This is the same approach as the verifier-benchmark (proven
satisfiable over BLS12-381). The hash function is not the "native" BLS12-381
Poseidon (which would use BLS12-381-specific MDS + round constants). For
production, replace with a proper BLS12-381 Poseidon instantiation. For this
hackathon demo, the security caveat is documented and acceptable — the circuit
still produces valid, verifiable proofs.

---

## Files to create / modify

### New
- `circuits/src/claim.circom` — the circuit template `Claim(DEPTH)`, main
  component `Claim(20)`, public signals in LOCKED order.
- `circuits/scripts/build-claim.sh` — automated build pipeline (see below).
- `circuits/scripts/gen-test-proof.mjs` — generate a sample input.json,
  witness, proof, and public.json for a depth-20 Merkle tree with one leaf;
  used by the end-to-end test in test stage.

### Modified
- `circuits/scripts/convert-to-soroban.mjs` — change input paths to read
  `claim_vk.json`, `claim_proof.json`, `claim_public.json` (new names) instead
  of `verification_key.json`, `proof.json`, `public.json`. Converter logic is
  already generic (IC/pubs arrays); only the filenames change.
- `package.json` `build:circuits` script — replace placeholder with
  `bash circuits/scripts/build-claim.sh`.
- `contracts/zeekpay/src/groth16_fixture.rs` — regenerated by converter after
  build. The fixture will now have 5 IC entries (1 for each of the 4 public
  inputs + IC[0]) and 4 PUBS entries. The existing test `real_proof_verifies`
  uses this fixture; it will be updated to call the real claim proof instead.

### Gitignore (no changes needed)
`circuits/build/*.ptau`, `*.zkey`, `*.wtns` already gitignored. `claim_vk.json`
and test `claim_proof.json` + `claim_public.json` are <1KB each and tracked.

---

## Build pipeline (`build-claim.sh`)

```
1. circom circuits/src/claim.circom --r1cs --wasm --sym -p bls12381 \
     -o circuits/build/
   → circuits/build/claim.r1cs
   → circuits/build/claim_js/claim.wasm + witness_calculator.js

2. [if circuits/build/pot13_final.ptau not found] generate pot13:
     snarkjs powersoftau new bls12-381 13 circuits/build/pot13_0.ptau -v
     snarkjs powersoftau contribute circuits/build/pot13_0.ptau \
       circuits/build/pot13_1.ptau --name="zeekpay-init" -e="<entropy>"
     snarkjs powersoftau prepare phase2 circuits/build/pot13_1.ptau \
       circuits/build/pot13_final.ptau -v
   (else reuse existing; pot13_final.ptau is ~14MB, gitignored)

3. snarkjs groth16 setup circuits/build/claim.r1cs \
     circuits/build/pot13_final.ptau circuits/build/claim_0.zkey
   snarkjs zkey contribute circuits/build/claim_0.zkey \
     circuits/build/claim.zkey --name="zeekpay" -e="<entropy>"
   → circuits/build/claim.zkey (gitignored)

4. snarkjs zkey export verificationkey circuits/build/claim.zkey \
     circuits/build/claim_vk.json
   → circuits/build/claim_vk.json (tracked, <1KB)

5. node circuits/scripts/convert-to-soroban.mjs
   → circuits/build/groth16_soroban.json + contracts/zeekpay/src/groth16_fixture.rs
```

---

## Test plan (test-results.md will capture real output)

1. **Constraint count:** `snarkjs r1cs info circuits/build/claim.r1cs` — verify
   constraint count in expected range (~5K–6K). Abort if >8192 (pot13 insufficient).
2. **Compile clean:** no errors/warnings from circom.
3. **Valid proof verifies:** `gen-test-proof.mjs` builds a 1-leaf depth-20 tree,
   generates a valid witness + proof, `snarkjs groth16 verify` → `true`.
4. **Tampered-nullifier fails:** modify nullifier in public.json, re-verify → `false`.
5. **Wrong-root fails:** modify root in public.json, re-verify → `false`.
6. **Rust test `real_proof_verifies` still passes** after fixture regeneration
   (now tests a real 4-input claim proof through the soroban-contract verifier +
   bls12_381 host fns). This is the key end-to-end closure from soroban-contract.
7. **Cargo tests still green:** `cargo test -p zeekpay` → 9 (or more) tests pass.
8. **WASM present:** `circuits/build/claim_js/claim.wasm` exists (needed by
   frontend proving step).

---

## Deviations from SPEC (allowed, noted here)

None. Circuit is minimal (one secret scalar + Merkle path), public inputs
match the LOCKED interface exactly, depth-20 stays fast in browser.

---

## Open questions (resolved)

- **Poseidon arity for nullifier:** Poseidon([secret]) — arity 1, domain-separate
  from commitment arity 3. Confirmed.
- **circomlib Poseidon vs native BLS12-381 Poseidon:** Use circomlib for hackathon
  (caveat documented). Upgrade path: switch library post-demo.
- **pot power needed:** 13 (8192 ≥ ~5500 constraints). Generate locally — free,
  offline, <1 min.
- **Converter filename changes:** only path strings change; logic untouched.

---

## Not built in this feature

- Key derivation (how recipient gets `secret`): deferred to `x-oauth-identity`.
- On-chain `set_vk` call with the new claim vk: deferred to `e2e-demo`.
- In-browser snarkjs integration: deferred to `frontend-claim`.
- Nullifier TTL/rent extension: carried open gap from soroban-contract.
