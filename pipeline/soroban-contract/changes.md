# soroban-contract — Code (changes.md)

## Files created / modified
- `contracts/zeekpay/Cargo.toml` — soroban-sdk =22.0.7; dev-deps testutils + hex.
- `contracts/zeekpay/src/verifier.rs` (new) — Groth16/BLS12-381 verifier on
  native host fns. `verify(env, vk, proof, pubs)`:
  `pairing_check([-A, alpha, L, C], [B, beta, gamma, delta])` with
  `L = IC[0] + Σ pub_i·IC[i+1]`. Rejects mismatched public-input count.
- `contracts/zeekpay/src/lib.rs` (new) — `ZeekPay` contract:
  - `initialize(admin, usdc_sac)`, `set_vk(VkData)`, `set_paused(bool)`.
  - `post_root(root)` — admin-only; rolling ring buffer of 64 roots (bounded
    storage, evicts oldest).
  - `deposit(from, denom, commitment)` — `from.require_auth`, pulls denom USDC
    via SAC into the contract, increments index, emits `deposit` event
    (commitment, denom, index) — NO sender.
  - `claim(proof_a, proof_b, proof_c, root, nullifier, recipient, denom)` —
    checks root known → nullifier unused → real Groth16 verify over derived
    public inputs → marks nullifier (checks-effects-interactions) → pays
    recipient → emits `claim` event (nullifier, denom) — NO commitment/link.
  - views `is_nullifier_used`, `is_known_root`.
  - `Denom` enum {1,10,50,100} → 7-decimal USDC amounts.
  - `Error` enum; `DataKey` storage keys.
  - public-input derivation (the contract⇄circuit interface):
    `[Fr(root), Fr(nullifier), Fr(recipient_digest), Fr(denom)]`, where
    `recipient_digest = sha256(recipient.to_xdr)` with the top byte zeroed
    (< BLS scalar field r).
  - `#[cfg(test)] test_support` — verify-skip flag for business-logic tests;
    `maybe_skip_verify` is `false` in the wasm build (cfg(not(test))).
- `contracts/zeekpay/src/groth16_fixture.rs` (new, @generated) — real
  snarkjs proof/vk in Soroban byte layout (public, throwaway-setup data).
- `circuits/scripts/convert-to-soroban.mjs` (new) — snarkjs JSON → Soroban byte
  layout (G1 X||Y; G2 X_c1||X_c0||Y_c1||Y_c0; Fr BE) + emits the Rust fixture.
- `contracts/zeekpay/src/test.rs` (new) — see test-results.md.

## .gitignore updates
None needed. `groth16_fixture.rs` (src, tracked) + `groth16_soroban.json`
(~2KB public) are intentionally tracked.

## New dependencies
- `hex` (dev-dep, test only). No new runtime crypto crate — verify uses host fns.

## Deviations from spec.md
1. **End-to-end claim with a REAL 4-input proof is deferred to circom-circuit.**
   The real claim circuit (Poseidon-Merkle membership, 4 public inputs) does not
   exist yet (next feature). So: the verifier is tested for real in isolation
   against the benchmark's 1-input proof; claim's business logic is tested via a
   `cfg(test)`-only verify bypass (excluded from wasm). Full real-proof claim is
   an e2e milestone.
2. `recipient` bound via `sha256(to_xdr)` digest (top byte zeroed). The circom
   circuit MUST replicate this encoding — locked as the interface here.

## Known gaps / TODOs (carried to circom-circuit / e2e)
- Real claim circuit + matching public-input encoding; end-to-end claim test.
- `Fr::from_bytes` behavior for caller-supplied root/nullifier ≥ r (panic vs
  reduce) — verify; a panic would be a DoS (not fund loss). Test in circom-circuit.
- vk is set post-deploy via `set_vk`; the real claim-circuit vk replaces the
  benchmark vk.
