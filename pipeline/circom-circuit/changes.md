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

---

## Addendum (2026-08-18): amount commitment + range proof

Note: by the time of this addendum the circuit already had 5 public inputs
`[root, nullifier, recipientDigest, amount, tokenId]` (drifted from the
4-input `denom` version this file otherwise describes — see `spec.md`
addendum). This change adds a 6th, appended last:

- `circuits/src/claim.circom`: new private input `blinding`; new public input
  `amountCommitment = Poseidon([amount, blinding])`; new range constraint
  `amount < 2^64` via circomlib `Num2Bits(64)` (`bitify.circom` now included).
- `circuits/src/compute_hashes.circom`: mirrors the new signals (test helper
  only) so `gen-test-proof.mjs` can derive a self-consistent `amountCommitment`.
- `circuits/scripts/gen-test-proof.mjs`: supplies `blinding`, derives and
  wires `amountCommitment` into `claim_input.json`.
- Constraint count: 11,420 → 12,133 (measured via `circom ... --r1cs`).
- Fresh pot14 ceremony + Groth16 setup run locally (none existed in this
  checkout); `claim.zkey`/`claim_vk.json`/`claim_proof.json`/`claim_public.json`
  regenerated for the new circuit shape.
- `circuits/scripts/convert-to-soroban.mjs` was deliberately **not run** —
  it overwrites `contracts/zeekpay/src/groth16_fixture.rs`, which is out of
  scope for this change. The contract's existing fixture/tests are untouched
  and unaffected.
- Test vectors: tampered `amountCommitment` (flip last public input by 1) →
  `snarkjs groth16 verify` returns false. Out-of-range amount (`2^64`, one
  past the bound) → witness generation itself fails with `Assert Failed` in
  the `Num2Bits` component (stronger than a verify-time failure: no valid
  proof can be constructed at all). Boundary case (`2^64 - 1`) generates and
  verifies a valid proof, confirming the bound isn't off-by-one.
- Full rationale for the Poseidon-vs-Pedersen substitution and the
  amount-still-public caveat is in the `claim.circom` header comment and
  `spec.md`'s addendum. See `BENCHMARK.md` (repo root) for cost numbers.

## D1 → D2 handoff: `groth16_fixture.rs` is now stale (on purpose)

As of this addendum, `contracts/zeekpay/src/groth16_fixture.rs` was
deliberately left untouched and no longer matches `circuits/build/claim_vk.json`:

| | public inputs | IC entries |
|---|---|---|
| `circuits/build/claim_vk.json` (current, 6-input circuit) | 6 | 7 |
| `contracts/zeekpay/src/groth16_fixture.rs` (unregenerated) | 5 | 6 |

This is safe, not silently broken: `verifier::verify` in
`contracts/zeekpay/src/verifier.rs` hard-checks
`vk.ic.len() != pubs.len() + 1` and returns `false` (→ `Error::InvalidProof`)
on any mismatch, before any pairing math runs. `Contract::claim` also has no
`amount_commitment` parameter and `derive_public_inputs` only ever pushes 5
`Fr`s, so `amountCommitment` does not influence fund movement anywhere on the
contract side today. Confirmed by grepping the whole repo outside
`circuits/src/` for `amountCommitment`/`amount_commitment`: no hits.

**Do not treat "regenerate the fixture" as a standalone task.** Regenerating
`groth16_fixture.rs` alone (just re-running `convert-to-soroban.mjs`) without
also updating `claim()`/`derive_public_inputs` would produce a fixture the
contract code doesn't know how to construct pubs for — it wouldn't fix
anything, just move the mismatch. When D2 picks this up, do it as one
coordinated change:

1. Add an `amount_commitment: BytesN<32>` (or equivalent) parameter to
   `Contract::claim` and thread it through `derive_public_inputs` as the 6th
   pushed `Fr`, matching `claim.circom`'s public-input order
   (`[root, nullifier, recipientDigest, amount, tokenId, amountCommitment]`).
2. Re-run `node circuits/scripts/convert-to-soroban.mjs` against the current
   `claim_vk.json` / `claim_proof.json` / `claim_public.json` to regenerate
   `groth16_fixture.rs`, and update any Rust unit test that currently assumes
   5 public inputs.
3. Re-run `set_vk` on the deployed contract with the new
   `circuits/build/groth16_soroban.json` (old proofs signed against the old
   vk will stop verifying the moment this lands — see the warning already in
   `build-claim.sh` about `claim.zkey` rotation).
4. Ship the new `claim.zkey` (and `claim.wasm` if it changed) to
   `frontend/public/circuits/`, and update proof-generation code
   (`frontend/src/lib/claim_tx.ts` and friends) to supply `blinding` as a
   circuit input and pass `amount_commitment` through to the `claim()` call.

Until step 1-4 land together, leave `groth16_fixture.rs` as-is rather than
partially regenerating it.

---

## 2026-09-14: the coordinated 7-input change, contract side

The D1 -> D2 handoff above is now half done. Steps 1 and 2 have landed; steps
3 and 4 have not. What changed, and what is still owed:

### What the contract now expects

`Contract::claim` binds SEVEN public inputs, in `claim.circom`'s locked order:

```
[root, nullifier, recipientDigest, amount, tokenId,
 amountCommitmentX, amountCommitmentY]
```

`derive_public_inputs` pushes all seven. The two commitment coordinates are
appended last, never inserted between the five that came before.

The circuit drifted past the 6-input Poseidon `amountCommitment` this file's
addendum describes: it is now a real Jubjub Pedersen commitment, one curve
point, so it costs two field elements rather than one.

### The new `claim` parameter

`claim` gained one argument, `amount_commitment: BytesN<64>`, holding
`BE(X) || BE(Y)`. It is ONE 64-byte argument rather than two 32-byte ones
because the SDK caps a contract function at 10 parameters including `env`, and
`claim` was already at the cap. `derive_public_inputs` splits the 64 bytes back
into two `Fr`. The layout matches the X||Y concatenation the verifier already
uses for a G1 point, so nothing new had to be invented.

Callers must append the argument. The old 9-argument call no longer compiles
and, on-chain, no longer matches the entry point.

`AMOUNT_MAX_EXCLUSIVE` and every other guard (canonical field elements, known
root, nullifier replay, pause, token registry) are unchanged. `amount` is still
a plaintext public input: the contract needs it in the clear for the SAC
transfer, so the commitment binds the amount, it does not hide it. Do not let
downstream copy say otherwise.

The `claim` event now carries `(nullifier, amount_commitment)`. It still carries
no note commitment, no amount and no token. The Pedersen commitment is blinded
and claimer-generated, is not the deposit's Merkle leaf, and is already visible
as a call argument, so emitting it links nothing that the transaction did not
already reveal.

### Which fixture

`contracts/zeekpay/src/groth16_fixture.rs` was regenerated from
`circuits/build/claim_{vk,proof,public}.json` at HEAD with

```
node circuits/scripts/convert-to-soroban.mjs --rs contracts/zeekpay/src/groth16_fixture.rs
```

`--rs` was used instead of the bare `FORCE_FIXTURE=1` invocation because the
bare one also rewrites `circuits/build/groth16_soroban.json`, which this change
deliberately left alone (see below). The constants are byte-for-byte identical
to `contracts/verifier/src/claim_fixture_7in.rs`, the benchmark fixture pinned
from the same proof, which is the cross-check that the conversion is right. IC
now has 8 entries, PUBS has 7.

### Still owed: `set_vk` and the frontend

- **The deployed contract still has the OLD verifying key.** Nothing here
  touched on-chain state. Until `set_vk` runs with the 7-input key, every claim
  against the deployed contract fails: the stored 6-entry IC cannot match the 7
  `Fr` the new code pushes, and `verifier::verify` rejects the length mismatch
  before any pairing math. It fails closed, not open.
- **`circuits/build/groth16_soroban.json` is still the 5-input conversion**, so
  `scripts/set_vk.mjs` would install the wrong key if run today. Regenerate it
  first, from the repo root:
  `FORCE_FIXTURE=1 node circuits/scripts/convert-to-soroban.mjs`
  (that rewrites the Rust fixture too, to the same bytes it already has).
- **`scripts/set_vk.mjs` still hard-codes 6 expected IC entries** for the claim
  key and aborts on anything else. It needs 8. Its header comment also still
  says the claim circuit has 5 public inputs. Both are outside this change's
  file scope and have to move with step 3.
- **The frontend still builds the 9-argument call** and does not supply
  `blinding` to the prover. That is step 4 of the handoff above and is owned
  elsewhere.
- Proofs made against the old `claim.zkey` stop verifying the moment `set_vk`
  lands. That is the rotation warning in `build-claim.sh`, and it is real.

### Tests

`contracts/zeekpay/src/test.rs` went from 26 to 30 tests. `real_proof_verifies`
now asserts the 7/8 shape explicitly, and `tampered_public_input_fails` was
corrected: it used to pass a single-element vector, so it was tripping the
length guard rather than testing tampering at all. New, all with the verify
bypass OFF and the pool over-funded so a rejection is the verifier's doing and
not an empty balance:

- `real_proof_claims_and_pays_recipient`: the real 7-input proof claims, the
  recipient balance rises by the amount, the pool falls by it.
- `tampered_commitment_x_pays_nothing` /
  `tampered_commitment_y_pays_nothing`: the committed vectors
  `circuits/build/claim_public_tampered_commitment.json` and
  `..._commitment_cy.json`, balances unchanged, nullifier still unspent.
- `wrong_public_input_count_pays_nothing`: six inputs against the seven-input
  vk at the verifier, and a six-input-shaped vk through `claim`, balances
  unchanged.

Each was mutation-checked: flipping the verify result in `claim` breaks the
happy path, feeding the untampered coordinates breaks both tamper tests, and
removing the IC/pubs length guard in `verifier::verify` breaks the count test.
