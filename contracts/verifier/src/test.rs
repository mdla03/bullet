//! Budget measurement for the Groth16-shaped verify (verifier-benchmark).
//!
//! Soroban's per-transaction CPU instruction limit is 100,000,000 (1e8). The
//! go/no-go question: does a real Groth16 verify shape (4-pair pairing_check +
//! IC MSM over `num_public_inputs + 1` points) fit, and with what margin?
#![cfg(test)]

use soroban_sdk::{BytesN, Env};

use crate::{BenchContract, BenchContractClient};
#[cfg(feature = "real-proof")]
use crate::claim_fixture_7in as fx;

/// Soroban network per-transaction CPU instruction limit.
const TX_CPU_LIMIT: u64 = 100_000_000;

#[cfg(feature = "real-proof")]
fn hex_to<const N: usize>(env: &Env, h: &str) -> BytesN<N> {
    let v = hex::decode(h).unwrap();
    let a: [u8; N] = v.try_into().unwrap();
    BytesN::from_array(env, &a)
}

fn measure(n_pairs: u32, msm_size: u32) -> (bool, u64, u64) {
    let env = Env::default();
    let id = env.register(BenchContract, ());
    let client = BenchContractClient::new(&env, &id);

    // Measure absolute cost: lift the limit so the op can't be cut off, then
    // read what it actually consumed.
    env.cost_estimate().budget().reset_unlimited();
    let ok = client.bench_verify(&n_pairs, &msm_size);
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let mem = env.cost_estimate().budget().memory_bytes_cost();
    (ok, cpu, mem)
}

#[test]
fn groth16_shape_fits_budget() {
    // The product claim shape: 4 pairings + IC MSM over 2 points (1 public input).
    let (ok, cpu, mem) = measure(4, 2);

    std::println!("=== Groth16-shaped verify (4 pairings + MSM-2) ===");
    std::println!("pairing_check result : {}", ok);
    std::println!("CPU instructions     : {}", cpu);
    std::println!("memory bytes         : {}", mem);
    std::println!("tx CPU limit         : {}", TX_CPU_LIMIT);
    std::println!(
        "budget used          : {:.2}%",
        (cpu as f64 / TX_CPU_LIMIT as f64) * 100.0
    );

    // Correctness: the canceling-pairs construction
    // e(P,Q)·e(-P,Q)·e(R,S)·e(-R,S) must reduce to the identity -> true.
    // (Cost is value-independent regardless; this just confirms the host fns
    // behave as expected. A real snarkjs proof also verifies off-chain.)
    assert!(ok, "canceling-pairs pairing_check must verify to true");
    assert!(
        cpu < TX_CPU_LIMIT,
        "Groth16-shaped verify ({} CPU) exceeds tx limit ({})",
        cpu,
        TX_CPU_LIMIT
    );
}

#[test]
fn cost_scaling_table() {
    std::println!("=== cost scaling ===");
    std::println!("shape                         | CPU instructions | % of 1e8 limit");
    for (np, ms, label) in [
        (2u32, 0u32, "2 pairings, no MSM"),
        (4, 0, "4 pairings, no MSM"),
        (4, 2, "4 pairings + MSM-2 (Groth16, 1 pub in)"),
        (4, 6, "4 pairings + MSM-6 (5 pub inputs)"),
        (4, 7, "4 pairings + MSM-7 (6 pub in, claim.circom)"),
        (4, 8, "4 pairings + MSM-8 (7 pub inputs)"),
        // Shielded-pool join-split shapes. 8 pub inputs is the 2-in/2-out
        // design (root, 2 nullifiers, 2 out commitments, deposit, withdraw,
        // tokenId); 10 and 12 are headroom for 3-in/3-out and 4-in/4-out.
        (4, 9, "4 pairings + MSM-9  (8 pub in, join-split 2x2)"),
        (4, 11, "4 pairings + MSM-11 (10 pub in, 3x3)"),
        (4, 13, "4 pairings + MSM-13 (12 pub in, 4x4)"),
    ] {
        let (ok, cpu, _mem) = measure(np, ms);
        std::println!(
            "{:30}| {:>16} | {:.2}%  (ok={})",
            label,
            cpu,
            (cpu as f64 / TX_CPU_LIMIT as f64) * 100.0,
            ok
        );
    }
}

/// Measured (not synthetic) on-chain verify cost for the real 7-public-input
/// Pedersen-shape claim circuit: the actual vk/proof/public signals from
/// `circuits/build/claim_{vk,proof,public}.json` at HEAD, converted to the
/// Soroban byte layout (see `claim_fixture_7in.rs`), run through the same
/// budget-metered `env.register` + client-call path `measure()` above uses.
/// A cost number for a proof that doesn't verify is meaningless, so this
/// also asserts the real proof verifies `true`.
#[cfg(feature = "real-proof")]
#[test]
fn real_7in_claim_proof_verify_cost() {
    let env = Env::default();
    let id = env.register(BenchContract, ());
    let client = BenchContractClient::new(&env, &id);

    let mut ic: soroban_sdk::Vec<BytesN<96>> = soroban_sdk::Vec::new(&env);
    for h in fx::IC {
        ic.push_back(hex_to::<96>(&env, h));
    }
    let mut pubs: soroban_sdk::Vec<BytesN<32>> = soroban_sdk::Vec::new(&env);
    for h in fx::PUBS {
        pubs.push_back(hex_to::<32>(&env, h));
    }
    assert_eq!(ic.len(), 8, "IC must have num_public_inputs + 1 = 8 points");
    assert_eq!(pubs.len(), 7, "claim.circom (Pedersen shape) has 7 public inputs");

    let alpha1 = hex_to::<96>(&env, fx::ALPHA1);
    let beta2 = hex_to::<192>(&env, fx::BETA2);
    let gamma2 = hex_to::<192>(&env, fx::GAMMA2);
    let delta2 = hex_to::<192>(&env, fx::DELTA2);
    let a = hex_to::<96>(&env, fx::PROOF_A);
    let b = hex_to::<192>(&env, fx::PROOF_B);
    let c = hex_to::<96>(&env, fx::PROOF_C);

    env.cost_estimate().budget().reset_unlimited();
    let ok = client.bench_verify_real(
        &alpha1, &beta2, &gamma2, &delta2, &ic, &a, &b, &c, &pubs,
    );
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let mem = env.cost_estimate().budget().memory_bytes_cost();

    const SIX_INPUT_CPU: u64 = 77_665_920;
    let delta = cpu as i64 - SIX_INPUT_CPU as i64;

    std::println!("=== Real 7-input claim proof verify (measured) ===");
    std::println!("verify result        : {}", ok);
    std::println!("CPU instructions     : {}", cpu);
    std::println!("memory bytes         : {}", mem);
    std::println!("tx CPU limit         : {}", TX_CPU_LIMIT);
    std::println!(
        "budget used          : {:.2}%",
        (cpu as f64 / TX_CPU_LIMIT as f64) * 100.0
    );
    std::println!(
        "headroom             : {:.2}%",
        100.0 - (cpu as f64 / TX_CPU_LIMIT as f64) * 100.0
    );
    std::println!("6-input measured cpu : {}", SIX_INPUT_CPU);
    std::println!("delta vs 6-input     : {:+}", delta);

    assert!(ok, "real 7-input claim proof must verify true on-chain");
    assert!(
        cpu < TX_CPU_LIMIT,
        "real 7-input claim verify ({} CPU) exceeds tx limit ({})",
        cpu,
        TX_CPU_LIMIT
    );
}
