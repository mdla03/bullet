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

// Minimal bump allocator — BENCHMARK ONLY, to let ark-ff link in the wasm build
// for the Poseidon-Merkle deposit-cost measurement. Never frees; not for product.
#[cfg(all(target_arch = "wasm32", not(test)))]
mod bench_alloc {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;

    const HEAP: usize = 256 * 1024;
    struct Bump {
        buf: UnsafeCell<[u8; HEAP]>,
        next: UnsafeCell<usize>,
    }
    unsafe impl Sync for Bump {}
    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let next = self.next.get();
            let align = layout.align();
            let start = (*next + align - 1) & !(align - 1);
            let end = start + layout.size();
            if end > HEAP {
                return core::ptr::null_mut();
            }
            *next = end;
            (self.buf.get() as *mut u8).add(start)
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }
    #[global_allocator]
    static A: Bump = Bump {
        buf: UnsafeCell::new([0u8; HEAP]),
        next: UnsafeCell::new(0),
    };
}

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

    /// Deposit-cost benchmark for Option A (on-chain Merkle insert).
    /// Runs a faithful Poseidon(2) arithmetic workload (t=3, 8 full + 57 partial
    /// rounds, x^5 S-box, 3x3 MDS) over BLS12-381 Fr in PURE WASM (no host fn —
    /// Soroban has no Poseidon host fn) for `levels` tree levels. Returns a
    /// value derived from the result to defeat dead-code elimination. Measure
    /// the real instruction cost by deploying + invoking on testnet.
    pub fn bench_merkle_insert(_env: Env, levels: u32) -> u32 {
        use ark_bls12_381::Fr;
        use ark_ff::{One, PrimeField, Zero};

        // x^5 S-box.
        fn sbox(x: Fr) -> Fr {
            let x2 = x * x;
            let x4 = x2 * x2;
            x4 * x
        }

        const R_F: u32 = 8; // full rounds
        const R_P: u32 = 57; // partial rounds
        const ROUNDS: u32 = R_F + R_P; // 65
        let half_full = R_F / 2; // 4

        // Pseudo round constant / MDS entries (nonzero so they can't be folded).
        let rc = Fr::from(7u64);
        let m = Fr::from(3u64);

        let mut acc = Fr::one();
        let mut lvl = 0u32;
        while lvl < levels {
            // Poseidon(2): absorb (acc, sibling), capacity 0.
            let mut s0 = acc;
            let mut s1 = acc + Fr::one(); // pseudo sibling, data-dependent
            let mut s2 = Fr::zero();

            let mut r = 0u32;
            while r < ROUNDS {
                let full = r < half_full || r >= (ROUNDS - half_full);
                // add round constants
                s0 += rc;
                s1 += rc;
                s2 += rc;
                // S-box layer (full: all 3; partial: first only)
                if full {
                    s0 = sbox(s0);
                    s1 = sbox(s1);
                    s2 = sbox(s2);
                } else {
                    s0 = sbox(s0);
                }
                // MDS mix (3x3 -> 9 muls)
                let n0 = s0 * m + s1 * m + s2 * m;
                let n1 = s0 * m + s1 * m + s2 * m;
                let n2 = s0 * m + s1 * m + s2 * m;
                s0 = n0;
                s1 = n1;
                s2 = n2;
                r += 1;
            }
            acc = s0;
            lvl += 1;
        }

        // Derive a u32 from the result (prevents DCE of the whole loop).
        // Use bigint limbs directly — no Vec alloc (contract wasm has no allocator).
        let bi = acc.into_bigint();
        let limb0 = bi.as_ref()[0];
        (limb0 as u32) ^ ((limb0 >> 32) as u32)
    }
}
