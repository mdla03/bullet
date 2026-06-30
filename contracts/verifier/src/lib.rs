//! Groth16 verifier — scaffold stub.
//!
//! Real verifier (or a benchmark stub measuring instruction budget) lands in
//! the `verifier-benchmark` pipeline feature. That benchmark gates the proof
//! system go/no-go decision before any product code.
//!
//! `#![no_std]` + `soroban-sdk` are added in that feature. The scaffold stub
//! stays `std` so `cargo build` is green on the host target with zero deps.
