# soroban-contract — Plan (spec.md)

## What & why
P0 feature 1. The on-chain core: `deposit`, `claim`, nullifier storage, fixed
denominations (1/10/50/100 USDC), event emission. Maps to SPEC.md §3 P0 #1.
Uses the locked proof system (Groth16/BLS12-381, verifier-benchmark).

**Security-sensitive: nullifier replay, verifier integration, fund custody,
USDC SAC transfers. Flawed nullifier = double-drain. Tests required.**

## DECISION DATA (benchmark A, on testnet — 2026-06-30)
Measured on-chain Poseidon-Merkle insert cost (pure-wasm `ark-bls12-381` Fr,
t=3, 8 full + 57 partial rounds, x^5 S-box, 3x3 MDS):
- **1 level (1 Poseidon hash): 20.82M instructions (20.8% of 100M budget).**
- **Depth-20 insert: 401.89M instructions = 401.9% — 4x OVER budget.**
- Ceiling that fits ≈ 3 levels (8 leaves) — useless anonymity set.

**Verdict: Option A (on-chain Poseidon Merkle) is a NO-GO.** Poseidon is
SNARK-friendly (cheap in-circuit / fast browser proving) but has no Soroban host
fn, so it is brutal on-chain. sha256/keccak have host fns (cheap on-chain) but
explode the circuit and kill in-browser proving (a P0 goal). **Recommended:
Option B** — off-chain Merkle, Poseidon in-circuit, contract stores known roots;
deposit stays cheap, claim = the ~70% Groth16 already benchmarked. Awaiting
owner confirmation of B.

## THE design fork (need your call before I write the spec further)
SPEC §2 requires two things that pull in different directions:
1. "No on-chain field links the deposit tx to the claim tx."
2. "Repeat payments to the same recipient land at independent one-time
   commitments."

If each deposit stores a commitment `C` and the claim references `C` directly,
then deposit(C) and claim(C) share `C` on-chain → **linkable**. To make them
unlinkable, the claim must prove it owns *some* commitment in the set **without
revealing which** — the Tornado-Cash pattern: a **Merkle tree of commitments**,
claim proves Merkle membership + reveals only `{root, nullifier, recipient}`.

Two ways to build it:

### Option A — Merkle tree, root computed ON-CHAIN (full Tornado)
- `deposit` inserts `C` into an on-chain Poseidon Merkle tree, recomputes root.
- Pro: fully trustless, canonical.
- Con: on-chain Poseidon hashing per insert is **expensive** (depth-20 tree =
  ~20 Poseidon hashes/insert). Poseidon over BLS field isn't a host function —
  it'd run in wasm. **Risk: deposit cost may blow the budget.** Needs its own
  mini-benchmark.

### Option B — Merkle tree, root maintained OFF-CHAIN, contract stores roots
- `deposit` stores `C` (emits event); an indexer builds the tree off-chain.
- Contract keeps a set of **known valid roots**; `claim` proves membership
  against any stored root.
- Pro: cheap deposits, claim verify is the ~70% Groth16 we benchmarked.
- Con: root insertion is permissioned/relayer-driven (a trust seam) OR roots
  are submitted with proofs. For a hackathon this is the common shortcut.

### Option C — No mixing: direct one-time-note claim (stealth-only)
- `deposit` stores `C`; `claim` reveals `C` + proves knowledge of its opening.
- Unlinkability is ONLY sender↔recipient-identity (the note doesn't name the
  recipient), NOT deposit↔claim (C is on both txs).
- Pro: tiny circuit (matches the 1-public-input benchmark exactly), simplest.
- Con: **does not satisfy SPEC §2 item 1** (deposit/claim ARE linkable by C).
  Honest-privacy README would have to say so.

**My recommendation: Option A IF a quick deposit-cost benchmark shows on-chain
Poseidon-Merkle insert fits; otherwise Option B.** Option C is fastest to demo
but weakens the headline privacy claim — I don't think it matches your SPEC.

I need your pick (or "benchmark A first") before finalizing the interface,
because it changes the contract storage model, the circuit (circom-circuit),
and the public-input count.

## Provisional public interface (assuming A or B — Merkle membership)
```rust
// denominations as an enum -> fixed u128 amounts (7-decimal USDC on Stellar)
enum Denom { One, Ten, Fifty, Hundred }   // 1,10,50,100 * 10^7 stroops-USDC

fn initialize(env, admin: Address, usdc_sac: Address);

// Pull `denom` USDC from `from` via the USDC SAC; insert commitment.
fn deposit(env, from: Address, denom: Denom, commitment: BytesN<32>);
//   emits: Deposit { commitment, denom, leaf_index }  (NO sender in event)

// Verify Groth16 proof; check root known; check nullifier unused; mark used;
// pay `recipient` the denom amount.
fn claim(env, proof: Bytes, root: BytesN<32>, nullifier: BytesN<32>,
         recipient: Address, denom: Denom);
//   emits: Claim { nullifier, denom }       (NO commitment / no link to deposit)

fn is_nullifier_used(env, nullifier: BytesN<32>) -> bool;  // view
```
Public inputs to the proof: `{root, nullifier, recipient, denom}` — recipient
bound in to prevent front-running/re-targeting (resolves the §6 open item).

## Storage model
- `Nullifiers`: persistent map `BytesN<32> -> ()` (presence = used).
- `Roots`: set of valid Merkle roots (A: just current; B: recent-N window).
- `Denom pools`: contract holds USDC; per-denom balance implicit in SAC balance.
- `Admin`, `usdc_sac`: instance storage.
- TTL/rent: bump persistent entries (nullifiers must never expire — a forgotten
  nullifier = double-spend; **call this out, test it**).

## USDC SAC integration
- Use the USDC Stellar Asset Contract client (`token::Client`) for
  `transfer(from, contract, amount)` on deposit and `transfer(contract,
  recipient, amount)` on claim.
- `USDC_SAC_ID` from env/config; on testnet, our own test USDC SAC.

## Verifier integration
- The real Groth16 verifier (decode snarkjs vk/proof bytes → `bls12_381` host
  fns). **First real risk: G2 Fp2 component byte-order** — must test the first
  on-chain verify against a known-good snarkjs proof (flagged in
  verifier-benchmark review). vk embedded as a constant (our trusted setup).

## Files (provisional)
- `contracts/zeekpay/Cargo.toml` — add soroban-sdk =22.0.7, token import.
- `contracts/zeekpay/src/lib.rs` — contract.
- `contracts/zeekpay/src/{verifier.rs, merkle.rs, storage.rs, events.rs}` (split).
- `contracts/zeekpay/src/test.rs` — happy path + adversarial (double-spend,
  bad proof, unknown root, wrong denom, replayed nullifier).
- The benchmark `verifier` crate stays as the cost reference; product verifier
  lives in `zeekpay` (or shared into `verifier` lib — decide in Code).

## Security-sensitive assumptions (CALLED OUT)
- **Nullifier replay = double-spend.** Check-then-set must be atomic; nullifier
  entries must be permanent (no TTL expiry). Adversarial tests mandatory.
- **Proof malleability / re-targeting:** recipient + denom bound as public
  inputs so a valid proof can't be redirected or up-valued.
- **Root validity:** claim must only accept proofs against a contract-known
  root (else forge membership).
- **vk integrity:** wrong/forged vk breaks soundness; vk is a compiled-in
  constant from our setup.
- **Fund custody:** contract holds pooled USDC; denom of claim must match the
  proof's denom public input (else drain a big note with a small proof).

## Open questions for owner
1. **Design fork above: A, B, or C? (or "benchmark A first")** — gates
   everything.
2. **Test USDC on testnet:** OK to deploy our own test USDC SAC (free) for
   tests, or use an existing testnet USDC issuer?
3. **Admin/upgradeability:** include an admin (pause, set vk) for the demo, or
   keep it immutable/minimal? Recommend minimal admin (pause only).
4. Merkle tree depth (if A/B) — propose 20 (1M notes). OK?

No code until you answer Q1 (and ideally 2–4).
