//! Groth16 verifier over BLS12-381, using Soroban's native `bls12_381` host
//! functions. Verifies the standard Groth16 equation
//!   e(A,B) = e(alpha,beta) · e(L,gamma) · e(C,delta)
//! where L = IC[0] + Σ pub_i · IC[i+1], rearranged into a single pairing_check:
//!   pairing_check([-A, alpha, L, C], [B, beta, gamma, delta]) == 1
//!
//! Byte layout (Soroban): G1 = BE(X)||BE(Y) (96B); G2 = BE(X_c1)||BE(X_c0)||
//! BE(Y_c1)||BE(Y_c0) (192B); Fr = BE (32B). snarkjs stores Fp2 as [c0,c1] so
//! the off-chain converter swaps to c1,c0 (see circuits/scripts/convert-to-soroban.mjs).
//!
//! SECURITY: soundness depends on (1) the vk being our genuine trusted-setup vk,
//! (2) the public inputs binding everything the contract cares about
//! (root, nullifier, recipient, amount — done in claim).

use soroban_sdk::crypto::bls12_381::{Fr, G1Affine, G2Affine};
use soroban_sdk::{Env, U256, Vec};

/// Groth16 verifying key (our trusted setup). `ic` has `num_public_inputs + 1`
/// G1 points.
#[derive(Clone)]
pub struct VerifyingKey {
    pub alpha1: G1Affine,
    pub beta2: G2Affine,
    pub gamma2: G2Affine,
    pub delta2: G2Affine,
    pub ic: Vec<G1Affine>,
}

/// A Groth16 proof.
#[derive(Clone)]
pub struct Proof {
    pub a: G1Affine,
    pub b: G2Affine,
    pub c: G1Affine,
}

/// Verify a Groth16 proof. `pubs.len()` must equal `vk.ic.len() - 1`.
pub fn verify(env: &Env, vk: &VerifyingKey, proof: &Proof, pubs: &Vec<Fr>) -> bool {
    let bls = env.crypto().bls12_381();

    // Public-input / IC length must match exactly — else a forged-length proof
    // could sidestep a bound input.
    if vk.ic.len() != pubs.len() + 1 {
        return false;
    }

    // L = IC[0] + Σ pub_i · IC[i+1]
    let mut ic_rest: Vec<G1Affine> = Vec::new(env);
    let mut i = 0u32;
    while i < pubs.len() {
        ic_rest.push_back(vk.ic.get(i + 1).unwrap());
        i += 1;
    }
    let acc = bls.g1_msm(ic_rest, pubs.clone());
    let l = bls.g1_add(&vk.ic.get(0).unwrap(), &acc);

    // -A  (negate via scalar -1 = 0 - 1, using host field arithmetic)
    let zero = Fr::from_u256(U256::from_u32(env, 0));
    let one = Fr::from_u256(U256::from_u32(env, 1));
    let neg_one = bls.fr_sub(&zero, &one);
    let neg_a = bls.g1_mul(&proof.a, &neg_one);

    // pairing_check([-A, alpha, L, C], [B, beta, gamma, delta]) == 1
    let mut g1s: Vec<G1Affine> = Vec::new(env);
    g1s.push_back(neg_a);
    g1s.push_back(vk.alpha1.clone());
    g1s.push_back(l);
    g1s.push_back(proof.c.clone());

    let mut g2s: Vec<G2Affine> = Vec::new(env);
    g2s.push_back(proof.b.clone());
    g2s.push_back(vk.beta2.clone());
    g2s.push_back(vk.gamma2.clone());
    g2s.push_back(vk.delta2.clone());

    bls.pairing_check(g1s, g2s)
}
