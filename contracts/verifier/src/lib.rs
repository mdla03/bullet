//! verifier-benchmark probe.
//!
//! Goal: measure the Soroban instruction cost of a Groth16-shaped verification
//! (one 4-pair `pairing_check` + one IC MSM) using the native `bls12_381` host
//! functions, to answer the project's biggest risk: does an on-chain Groth16
//! verifier fit inside Soroban's per-transaction instruction budget?
//!
//! This is NOT the product verifier. It does not bind real proof/vk bytes, has
//! no nullifiers, no storage, no recipient binding. See spec.md.
#![no_std]

#[cfg(test)]
extern crate std;
#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, Env, Vec};

#[contract]
pub struct BenchContract;

#[contractimpl]
impl BenchContract {
    /// Runs a Groth16-shaped check: a `pairing_check` over `n_pairs` pairings
    /// plus a `msm_size`-point G1 MSM (the IC accumulation). Returns the
    /// pairing_check result, which is constructed to be `true`.
    pub fn bench_verify(env: Env, n_pairs: u32, msm_size: u32) -> bool {
        use soroban_sdk::crypto::bls12_381::{Fr, G1Affine, G2Affine};

        let bls = env.crypto().bls12_381();
        let dst = soroban_sdk::Bytes::from_slice(&env, b"ZEEKPAY-BENCH-DST");

        // Two independent, valid points via hash-to-curve.
        let p: G1Affine = bls.hash_to_g1(&soroban_sdk::Bytes::from_slice(&env, b"P"), &dst);
        let r: G1Affine = bls.hash_to_g1(&soroban_sdk::Bytes::from_slice(&env, b"R"), &dst);
        let q: G2Affine = bls.hash_to_g2(&soroban_sdk::Bytes::from_slice(&env, b"Q"), &dst);
        let s: G2Affine = bls.hash_to_g2(&soroban_sdk::Bytes::from_slice(&env, b"S"), &dst);

        // -1 in Fr, via the host's own field arithmetic (no endianness or
        // modulus assumptions): neg_one = 0 - 1.
        let zero = Fr::from_u256(soroban_sdk::U256::from_u32(&env, 0));
        let one = Fr::from_u256(soroban_sdk::U256::from_u32(&env, 1));
        let neg_one = bls.fr_sub(&zero, &one);

        let neg_p = bls.g1_mul(&p, &neg_one);
        let neg_r = bls.g1_mul(&r, &neg_one);

        // Build the pairing vectors. Base shape is 4 canceling pairs:
        //   e(P,Q)*e(-P,Q)*e(R,S)*e(-R,S) = 1  -> true
        // If n_pairs is larger/smaller we repeat/truncate the canceling pattern
        // in even counts to keep the product == 1.
        let mut g1s: Vec<G1Affine> = Vec::new(&env);
        let mut g2s: Vec<G2Affine> = Vec::new(&env);
        let mut added = 0u32;
        while added + 2 <= n_pairs {
            if added % 4 == 0 {
                g1s.push_back(p.clone());
                g2s.push_back(q.clone());
                g1s.push_back(neg_p.clone());
                g2s.push_back(q.clone());
            } else {
                g1s.push_back(r.clone());
                g2s.push_back(s.clone());
                g1s.push_back(neg_r.clone());
                g2s.push_back(s.clone());
            }
            added += 2;
        }

        // IC MSM: msm_size G1 points scaled by msm_size scalars, accumulated.
        if msm_size > 0 {
            let mut ic: Vec<G1Affine> = Vec::new(&env);
            let mut scalars: Vec<Fr> = Vec::new(&env);
            let mut k = 0u32;
            while k < msm_size {
                ic.push_back(if k % 2 == 0 { p.clone() } else { r.clone() });
                scalars.push_back(neg_one.clone());
                k += 1;
            }
            let _acc = bls.g1_msm(ic, scalars);
        }

        bls.pairing_check(g1s, g2s)
    }
}
