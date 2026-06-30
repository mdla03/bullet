//! Budget measurement for the Groth16-shaped verify (verifier-benchmark).
//!
//! Soroban's per-transaction CPU instruction limit is 100,000,000 (1e8). The
//! go/no-go question: does a real Groth16 verify shape (4-pair pairing_check +
//! IC MSM over `num_public_inputs + 1` points) fit, and with what margin?
#![cfg(test)]

use soroban_sdk::Env;

use crate::{BenchContract, BenchContractClient};

/// Soroban network per-transaction CPU instruction limit.
const TX_CPU_LIMIT: u64 = 100_000_000;

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
        (4, 8, "4 pairings + MSM-8 (7 pub inputs)"),
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
