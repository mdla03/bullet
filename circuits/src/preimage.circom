pragma circom 2.0.0;

// Trivial benchmark circuit for verifier-benchmark.
// Proves knowledge of `secret` such that `hash == Poseidon(secret)`.
// `hash` is the single PUBLIC signal (the main-component output); `secret`
// is private. This is the smallest circuit that yields a real Groth16 proof
// with exactly one public input — enough to measure on-chain verify cost.
//
// NOTE: circomlib's Poseidon round constants are defined over the BN254 field.
// Compiled with `-p bls12381` they still form a valid, satisfiable arithmetic
// circuit (the Groth16 proof generates and verifies correctly), but it is NOT
// canonical Poseidon over the BLS12-381 scalar field. That distinction does not
// affect verifier cost (pairings + public-input count) and is deferred to the
// circom-circuit feature. Do NOT reuse this hash as-is in product code.

include "../node_modules/circomlib/circuits/poseidon.circom";

template Preimage() {
    signal input secret;   // private
    signal output hash;    // public

    component p = Poseidon(1);
    p.inputs[0] <== secret;
    hash <== p.out;
}

component main = Preimage();
