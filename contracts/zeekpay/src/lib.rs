//! ZeekPay main contract — scaffold stub.
//!
//! Product logic (deposit / claim / nullifier storage / fixed denominations /
//! event emission) lands in the `soroban-contract` pipeline feature.
//!
//! `#![no_std]` + `soroban-sdk` are added in that feature (they require the
//! wasm32 target + an SDK-provided panic handler). The scaffold stub stays
//! `std` so `cargo build` is green on the host target with zero deps.
