pragma circom 2.0.0;

// ZeekPay claim circuit — Groth16/BLS12-381, Poseidon-Merkle membership + nullifier.
//
// Proof statement:
//   prover knows `secret` such that:
//     nullifier         = Poseidon([secret])
//     commitment        = Poseidon([secret, recipientDigest, denom])
//     commitment ∈ Merkle tree at `root` (with an opening path of depth 20)
//
// Public inputs (LOCKED — must match derive_public_inputs in contracts/zeekpay/src/lib.rs):
//   [root, nullifier, recipientDigest, denom]   ← order is the snarkjs public-signal order
//
// Security: recipientDigest and denom are inside the commitment preimage so that
// a front-runner cannot substitute their own recipient or denomination while reusing
// the same secret. Nullifier arity (1) differs from commitment arity (3) for
// domain separation.
//
// NOTE: uses circomlib Poseidon (BN254 round constants) compiled over BLS12-381
// (-p bls12381). The circuit is satisfiable and the proofs verify correctly, but
// this is not canonical Poseidon over the BLS12-381 scalar field. Acceptable for
// the hackathon demo; replace with a native BLS12-381 Poseidon for production.

include "../node_modules/circomlib/circuits/poseidon.circom";

template Claim(DEPTH) {
    // ── public inputs (order matches derive_public_inputs) ────────────────────
    signal input root;
    signal input nullifier;
    signal input recipientDigest;
    signal input denom;

    // ── private inputs ────────────────────────────────────────────────────────
    signal input secret;
    signal input pathElements[DEPTH];  // Merkle sibling hashes
    signal input pathIndices[DEPTH];   // 0 = current node is left, 1 = right

    // ── nullifier derivation ──────────────────────────────────────────────────
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.out === nullifier;

    // ── commitment derivation ─────────────────────────────────────────────────
    component commitmentHasher = Poseidon(3);
    commitmentHasher.inputs[0] <== secret;
    commitmentHasher.inputs[1] <== recipientDigest;
    commitmentHasher.inputs[2] <== denom;

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
}

component main {public [root, nullifier, recipientDigest, denom]} = Claim(20);
