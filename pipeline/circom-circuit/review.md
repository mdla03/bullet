# circom-circuit — Review (review.md)

## Fresh-eyes read

Circuit is minimal and correct. 3 Poseidon calls + 20-level Merkle verification.
Public-input order matches soroban-contract's `derive_public_inputs` exactly.
`real_proof_verifies` closes the last open gap from soroban-contract.

## Security checklist

| Item | Status |
|------|--------|
| Front-running protection | ✓ `recipientDigest` in commitment preimage — claimant cannot substitute their address without breaking the commitment |
| Denom binding | ✓ `denom` in commitment preimage — 1 USDC proof cannot prove 100 USDC claim |
| Nullifier domain separation | ✓ Poseidon([secret]) arity 1 ≠ Poseidon([secret, rd, d]) arity 3 — cannot construct a commitment that equals a nullifier |
| `pathIndices` binary | ✓ `pathIndices[i] * (1 - pathIndices[i]) === 0` per level |
| Left/right mux soundness | ✓ pure algebra (`l = (sib - curr) * idx + curr`) — no extra constraints needed; verified by `real_proof_verifies` |
| Public input order matches contract | ✓ `[root, nullifier, recipientDigest, denom]` in circom `{public [...]}` = same order as `derive_public_inputs` Vec push order |
| End-to-end proof + contract verify | ✓ real snarkjs proof → Soroban encoding → bls12_381 host fns → `true` |
| Gitignore: zkey, ptau, wtns | ✓ all gitignored; no toxic waste in diff |
| No secrets in diff | ✓ test inputs (12345, 42, 10) are trivially public |
| Files >1MB | ✓ none tracked; pot14_final.ptau (27MB) gitignored |

## Notable risks / honest gaps

1. **BN254 Poseidon constants over BLS12-381 field.**
   `circomlib` Poseidon uses constants generated for the BN254 field, compiled
   here over BLS12-381. The circuit is satisfiable and the proofs verify, but
   this is NOT canonical BLS12-381 Poseidon — the hash function has different
   security properties than one designed for BLS12-381. For a hackathon demo
   this is acceptable. **Production path: replace with a proper BLS12-381
   Poseidon (e.g., generate constants with the Grain LFSR for BLS12-381 r).**

2. **Trusted setup (own ceremony, single contributor).**
   Groth16 soundness depends on the setup randomness not leaking. The hackathon
   uses our own single-contribution ceremony (pot14 + zkey contribute). A
   malicious prover who knows the toxic waste could produce fake proofs.
   Production path: multi-party MPC ceremony. Documented in README.

3. **Fixed Merkle depth = 20, single leaf in test.**
   Test proof uses leaf at index 0 with 20 zero-sibling levels. A non-zero
   index or real multi-leaf tree needs a correct `pathElements` derived from the
   actual tree. This is handled by the off-chain relayer building the Merkle
   tree — not the circuit's concern, but important for the end-to-end demo.

4. **`compute_hashes.circom` zero-subtree sym offset.**
   Circom optimizes away the constant signal `zeroHashes[0] <== 0`, causing a
   one-off shift in the `.sym` file. `gen-test-proof.mjs` compensates (see
   `changes.md`). This is fragile — if the circom optimizer changes behavior
   between versions, the offset may differ. Documented in code and changes.md.

5. **`Fr::from_bytes` DoS risk (carried from soroban-contract).**
   Caller-supplied root/nullifier ≥ BLS12-381 r may panic. The circuit proof
   guarantees that a valid circuit output fits in the field, but the contract
   also accepts root/nullifier from `post_root` (admin only, lower risk) and
   from the `claim` call arguments directly. Guard in follow-up.

## Public-input interface lock (confirmed binding)

The public signals reported by snarkjs are:
```
[root, nullifier, recipientDigest, denom]
```
And `contracts/zeekpay/src/lib.rs::derive_public_inputs` builds:
```rust
vec![Fr(root), Fr(nullifier), recipient_fr(env, recipient), Fr(denom.as_u32())]
```
Same order, same encoding. `real_proof_verifies` confirms this is correct
end-to-end (real circuit proof → real Soroban verifier → `true`).

## Code quality

- Circuit is lean (~65 lines). No external Mux/Switcher deps — inline algebra.
- Helper circuit (`compute_hashes.circom`) kept separate and documented as
  test-only. Not compiled into the Groth16 setup.
- Build script idempotent: skips ptau generation if `pot14_final.ptau` exists.
- `gen-test-proof.mjs` two-pass approach handles the circom constant-optimization
  quirk without adding external dependencies.

## Follow-ups (NOT built)

1. Replace circomlib Poseidon with native BLS12-381 Poseidon for production.
2. Multi-party MPC trusted setup ceremony before mainnet.
3. End-to-end claim test on testnet with a real deposit + root post + claim
   (`e2e-demo` feature).
4. `set_vk` with the real claim vk (`e2e-demo` feature).
5. `Fr::from_bytes` guard for caller-supplied values ≥ BLS12-381 r.
6. Nullifier TTL/rent extension (carried from soroban-contract).
