pragma circom 2.0.0;

// ZeekPay claim circuit — Groth16/BLS12-381, Poseidon-Merkle membership + nullifier.
//
// Proof statement:
//   prover knows `secret` such that:
//     nullifier         = Poseidon([secret])
//     commitment        = Poseidon([secret, recipientDigest, amount, tokenId])
//     commitment ∈ Merkle tree at `root` (with an opening path of depth 20)
//   and additionally knows `blinding` such that:
//     amountCommitment  = Poseidon([amount, blinding])
//     amount            < 2^64 (range proof, see below)
//
// Public inputs (LOCKED — must match derive_public_inputs in contracts/zeekpay/src/lib.rs):
//   [root, nullifier, recipientDigest, amount, tokenId, amountCommitment]
//   `amount` is the raw stroop value (7 decimal places; e.g. 100000000 for 10 USDC).
//   `tokenId` is a uint mapping: 0 = USDC, 1 = XLM. Bound in the commitment so a
//   deposit of token A cannot be claimed as token B.
//   `amountCommitment` is NEW — appended after the five pre-existing public
//   signals, never inserted between them (public-input order is locked; snarkjs
//   assigns indices by declaration order in `component main {public [...]}`).
//
// Security: recipientDigest, amount, and tokenId are inside the commitment preimage
// so that a front-runner cannot substitute their own recipient, amount, or token
// while reusing the same secret. Nullifier arity (1) differs from commitment
// arity (4) for domain separation.
//
// NOTE: uses circomlib Poseidon (BN254 round constants) compiled over BLS12-381
// (-p bls12381). The circuit is satisfiable and the proofs verify correctly, but
// this is not canonical Poseidon over the BLS12-381 scalar field. Acceptable for
// the hackathon demo; replace with a native BLS12-381 Poseidon for production.
//
// ── amountCommitment / range proof — honest scope note ──────────────────────
// SPEC.md designates a fully-encrypted, Pedersen-commitment amount scheme as P3
// ("the real destination for amount privacy"), out of scope for v1 because a
// flawed range proof lets someone withdraw more than they deposited, and v1's
// actual amount-privacy mechanism is fixed denominations, not encryption. This
// addition was built as an explicit, written scope override by the project
// owner (P0 binding-scope exception documented in the task that produced this
// diff), added on a defense-in-depth basis:
//   - `amount` REMAINS a plaintext public input, unchanged. The Soroban
//     contract needs it in the clear to drive `token::Client::transfer`, and
//     that contract is out of scope for this change, so this circuit cannot
//     make `amount` actually hidden on-chain. Anyone reading the public
//     inputs (or the resulting SAC transfer) sees the amount exactly as
//     before. Do not describe this as amount-hiding in downstream copy.
//   - `amountCommitment` is a Poseidon hash commitment, NOT a literal
//     elliptic-curve Pedersen commitment. circomlib's Pedersen template uses
//     Baby Jubjub curve constants that are a sound, hard-discrete-log group
//     only over the BN254 scalar field. This circuit compiles under
//     `-p bls12381` (locked, matching the rest of the circuit and the
//     Soroban bls12_381 verifier) — under that modulus Baby Jubjub's
//     constants do not describe a curve with any proven security property.
//     Using it anyway would be a strictly worse, unverified version of the
//     same BN254-under-BLS12-381 caveat already accepted for Poseidon above.
//     A Poseidon-based commitment keeps the same, already-documented caveat
//     instead of introducing a new, unverified one. Hiding relies on
//     `blinding` being uniform prover-chosen randomness; binding relies on
//     Poseidon collision resistance.
//   - The range proof constrains the SAME plaintext `amount` signal that is
//     bound into `amountCommitment`, to `0 <= amount < 2^64` (AMOUNT_BITS =
//     64). This bound is not arbitrary: `derive_public_inputs` in
//     contracts/zeekpay/src/lib.rs encodes amount via
//     `U256::from_parts(env, 0, 0, 0, amount as u64)`, i.e. it silently
//     truncates any i128 amount to its low 64 bits. The constraint makes an
//     in-circuit witness for `amount >= 2^64` unsatisfiable, so a prover
//     cannot produce a proof whose own committed amount exceeds the range.
//     It is a real integrity check; it is not amount privacy.
//
//     CORRECTION (2026-08-20, D1 audit): an earlier version of this comment
//     said the constraint closes the truncation decoupling. It does not, and
//     on its own it never could. The attack does not need an in-circuit
//     witness for the oversized value: the attacker proves an honest small
//     amount X and hands the contract an i128 of `2^64 + X`, which truncates
//     back to X in `derive_public_inputs`, verifies against the honest proof,
//     and transfers the full oversized i128. The value never passes through
//     the circuit at all. Closing it requires a contract-side bound, now
//     present as `AMOUNT_MAX_EXCLUSIVE` in contracts/zeekpay/src/lib.rs and
//     pinned by `claim_amount_at_or_above_2_64_rejected` in that crate's
//     tests. Treat this circuit constraint and that contract guard as one
//     mechanism in two halves: keep the two bounds equal, and do not remove
//     either on the assumption that the other covers it.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

template Claim(DEPTH, AMOUNT_BITS) {
    // ── public inputs (order matches derive_public_inputs) ────────────────────
    signal input root;
    signal input nullifier;
    signal input recipientDigest;
    signal input amount;
    signal input tokenId;
    signal input amountCommitment;   // NEW — appended last, see note above

    // ── private inputs ────────────────────────────────────────────────────────
    signal input secret;
    signal input pathElements[DEPTH];  // Merkle sibling hashes
    signal input pathIndices[DEPTH];   // 0 = current node is left, 1 = right
    signal input blinding;             // NEW — randomness for amountCommitment

    // ── nullifier derivation ──────────────────────────────────────────────────
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.out === nullifier;

    // ── commitment derivation ─────────────────────────────────────────────────
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== secret;
    commitmentHasher.inputs[1] <== recipientDigest;
    commitmentHasher.inputs[2] <== amount;
    commitmentHasher.inputs[3] <== tokenId;

    // ── Merkle membership proof ───────────────────────────────────────────────
    component levelHashers[DEPTH];
    signal levelHashes[DEPTH + 1];
    signal left[DEPTH];
    signal right[DEPTH];

    levelHashes[0] <== commitmentHasher.out;

    for (var i = 0; i < DEPTH; i++) {
        // Constrain pathIndices[i] to {0, 1}
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // pathIndices[i]==0: current is left child, sibling is right
        // pathIndices[i]==1: current is right child, sibling is left
        left[i]  <== (pathElements[i] - levelHashes[i]) * pathIndices[i] + levelHashes[i];
        right[i] <== (levelHashes[i] - pathElements[i]) * pathIndices[i] + pathElements[i];

        levelHashers[i] = Poseidon(2);
        levelHashers[i].inputs[0] <== left[i];
        levelHashers[i].inputs[1] <== right[i];
        levelHashes[i + 1] <== levelHashers[i].out;
    }

    // ── root check ────────────────────────────────────────────────────────────
    levelHashes[DEPTH] === root;

    // ── amount commitment (NEW, see header note) ──────────────────────────────
    // Poseidon hash commitment: amountCommitment = Poseidon([amount, blinding]).
    component amountCommitmentHasher = Poseidon(2);
    amountCommitmentHasher.inputs[0] <== amount;
    amountCommitmentHasher.inputs[1] <== blinding;
    amountCommitmentHasher.out === amountCommitment;

    // ── amount range proof (NEW, see header note) ─────────────────────────────
    // Decomposing into AMOUNT_BITS bits only succeeds if 0 <= amount < 2^AMOUNT_BITS.
    component amountBits = Num2Bits(AMOUNT_BITS);
    amountBits.in <== amount;
}

component main {public [root, nullifier, recipientDigest, amount, tokenId, amountCommitment]} = Claim(20, 64);
