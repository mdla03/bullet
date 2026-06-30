# soroban-contract — Test (test-results.md)

Command: `cargo test -p zeekpay`

```
running 9 tests
test test::claim_before_init_fails ... ok
test test::wrong_public_input_count_fails ... ok
test test::unknown_root_rejected ... ok
test test::post_root_requires_admin_auth ... ok
test test::paused_blocks_deposit_and_claim ... ok
test test::happy_path_deposit_then_claim ... ok
test test::double_spend_rejected ... ok
test test::tampered_public_input_fails ... ok
test test::real_proof_verifies ... ok

test result: ok. 9 passed; 0 failed
```
Plus `cargo build -p zeekpay --target wasm32-unknown-unknown --release` → 19K
wasm (confirms the cfg(test) verify-bypass is excluded from the shipped build).

## Crypto correctness (real, no bypass)
- **`real_proof_verifies`** — the real snarkjs Groth16/BLS12-381 proof from the
  benchmark setup verifies `true` through the contract's verifier + host fns.
  **This is the definitive proof that the snarkjs→Soroban byte encoding (G2
  c1,c0 order especially) is correct.**
- **`tampered_public_input_fails`** — swapping the public input → `false`.
- **`wrong_public_input_count_fails`** — `pubs.len() != ic.len()-1` → rejected.

## Business logic (adversarial; cfg(test) verify-skip)
- **`happy_path_deposit_then_claim`** — deposit 10 USDC pulls from depositor into
  the contract (balances 100M / 900M); post_root; claim pays recipient 10 USDC,
  contract drains to 0, nullifier marked used.
- **`double_spend_rejected`** — second claim with the same nullifier →
  `NullifierUsed`; recipient paid exactly once. (Nullifier is marked BEFORE the
  payout transfer — checks-effects-interactions, so a reentrant recipient can't
  replay.)
- **`unknown_root_rejected`** — claim against an unposted root → `UnknownRoot`.
- **`paused_blocks_deposit_and_claim`** — deposit while paused → `Paused`.
- **`claim_before_init_fails`** — claim before initialize → `NotInitialized`.
- **`post_root_requires_admin_auth`** — with auths cleared, `post_root` fails
  (admin auth required).

## Adversarial cases covered (per SPEC §6 mandate)
- ✓ Nullifier double-spend (the fund-drain risk).
- ✓ Malformed/tampered proof + wrong public-input count.
- ✓ Unauthorized admin action (post_root).
- ✓ Unknown root (forged-membership guard).
- ✓ Pause + uninitialized guards.

## NOT tested yet (and why)
- **End-to-end claim with a REAL matching proof** — needs the real 4-public-input
  claim circuit (circom-circuit). The verifier is proven real in isolation; the
  business logic is proven with the bypass. Joined in circom-circuit / e2e-demo.
- **`Fr::from_bytes` with root/nullifier ≥ r** — caller-supplied edge; behavior
  (panic vs reduce) to confirm in circom-circuit.
- **On testnet** — contract deploy + real invoke deferred to e2e-demo (free).
