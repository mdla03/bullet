# soroban-contract — Review (review.md)

## Fresh-eyes read
Contract is small and readable. deposit/claim/post_root match the locked Option
B plan. Verifier is isolated in `verifier.rs` and proven against a real proof.

## Security checklist
| Item | Status |
|------|--------|
| Nullifier replay = double-spend | ✓ checked-then-set; marked BEFORE payout (checks-effects-interactions); tested (`double_spend_rejected`) |
| Nullifier permanence (no TTL expiry) | ⚠ persistent entry but **no explicit rent bump** — a nullifier whose entry expires would re-enable a double-spend. MUST add `extend_ttl` / archival handling before mainnet. Flagged for follow-up. |
| Recipient binding (anti front-run) | ✓ recipient is a bound public input (sha256(to_xdr) digest) |
| Denom binding (anti small-proof/big-note drain) | ✓ denom is a bound public input |
| Unknown-root / forged membership | ✓ only contract-posted roots accepted; tested |
| Verifier soundness | ✓ real host-fn pairing; correct vk required (set by admin); encoding proven by real-proof test |
| Admin authorization | ✓ require_auth on admin ops; tested |
| Reentrancy on payout | ✓ nullifier set before transfer |
| Pause guard | ✓ deposit + claim |
| Secrets / toxic waste in diff | ✓ none; fixture is public throwaway-setup data |
| Files >1MB | ✓ none |

## Notable risks / honest gaps
1. **Nullifier TTL.** Soroban persistent storage can be archived if rent lapses.
   A reaped nullifier = double-spend. v1 has no `extend_ttl`. **Top follow-up.**
2. **Public-input encoding is a contract⇄circuit contract.** `derive_public_inputs`
   (root, nullifier, sha256-recipient, denom) MUST be matched exactly by the
   circom claim circuit, or every real proof fails. Locked here; circom-circuit
   must conform.
3. **`Fr::from_bytes` on caller-supplied root/nullifier ≥ r** — possible panic
   (DoS, not fund loss). Confirm + guard in circom-circuit.
4. **Option B trust seam:** `post_root` is admin/relayer-trusted. A malicious
   root poster could admit a forged tree. This is the documented Option B
   limitation — README must state it. Not a code bug; a design tradeoff.
5. **End-to-end claim unproven until circom-circuit.** Verifier real + logic real,
   but never together with a real 4-input proof. Must close in circom-circuit/e2e.

## Code quality
- `verifier.rs` cleanly separated; reusable.
- `test_support` bypass is cfg(test)-gated; confirmed absent from 19K wasm.
- Ring-buffer root eviction keeps storage bounded (good).
- Minor: `Setup` has unused fields (allow(dead_code)); harmless.

## README accuracy
README needs an Option-B note (off-chain Merkle, relayer posts roots = trust
seam). **Action:** add to README honest-limits when circom-circuit lands the
full flow, or now. Currently README doesn't mention the root-poster seam — TODO.

## Recommended follow-ups (NOT built)
1. Nullifier (and root) TTL/rent extension before any non-demo use.
2. circom-circuit: real Poseidon-Merkle membership circuit matching
   `derive_public_inputs`; then an end-to-end claim test + testnet invoke.
3. README: document the Option B root-poster trust seam.
4. Consider events including the leaf index range a root covers (helps indexer).
