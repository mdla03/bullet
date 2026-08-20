//! ZeekPay main contract — Option B (off-chain Merkle).
//!
//! deposit: pull tokens from `from`, store commitment, emit event (cheap).
//! post_root: admin/relayer publishes an off-chain-computed Merkle root (the
//!   Option-B trust seam — documented in README honest-limits).
//! claim: verify a Groth16 proof (real, BLS12-381 host fns) that the caller owns
//!   a note in the tree under a known root, with {root, nullifier, recipient,
//!   amount, tokenId} bound as public inputs; reject replayed nullifiers; pay
//!   the recipient in the correct token.
//!
//! SECURITY-SENSITIVE: nullifier replay = double-spend; recipient+amount+tokenId
//! binding prevents front-running / amount-mismatch / cross-token drains; only
//! contract-known roots are accepted. See src/test.rs for the verifier correctness
//! test against a real snarkjs proof and the adversarial business-logic tests.
#![no_std]

#[cfg(test)]
extern crate std;

mod verifier;

#[cfg(test)]
mod groth16_fixture;
#[cfg(test)]
mod joinsplit_fixture;
#[cfg(test)]
mod test;

use soroban_sdk::crypto::bls12_381::{Fr, G1Affine, G2Affine};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Vec,
};

use verifier::{Proof, VerifyingKey};

const ROOT_WINDOW: u32 = 64; // recent valid roots kept

// Amounts must fit in u64. `derive_public_inputs` encodes `amount` as
// `amount as u64`, which silently truncates: without this bound, a proof
// generated for X also satisfies verification for a claim of 2^64 + X, while
// `token::Client::transfer` moves the full i128. That decouples the amount the
// proof authorises from the amount actually paid out.
//
// This is the contract-side half of the range proof. `claim.circom` constrains
// the same bound in-circuit via `Num2Bits(64)`; the circuit alone cannot close
// the gap, because the attack supplies the oversized value to the contract
// rather than to the prover. Keep the two bounds equal.
const AMOUNT_MAX_EXCLUSIVE: i128 = 1i128 << 64;

// Persistent-entry TTL management (~5s per ledger on Stellar). `extend_to` must
// stay under the network `max_entry_ttl` (3,110,400 on mainnet) or `extend_ttl`
// traps, so these are chosen to be valid on both testnet and mainnet. Persistent
// entries archive rather than delete (a restore preserves the stored value), but
// a reaped nullifier read would still trap the claim tx; bumping on every write
// keeps nullifiers and in-window roots live so honest claims never hit that path.
const LEDGERS_PER_DAY: u32 = 17_280;
// Nullifiers gate double-spends: bump the hardest.
const NULLIFIER_BUMP_THRESHOLD: u32 = 60 * LEDGERS_PER_DAY; // ~60 days
const NULLIFIER_BUMP_TO: u32 = 3_000_000; // ~173 days, < mainnet max_entry_ttl
// Roots must outlive their ring-buffer window so in-window claims never fail.
const ROOT_BUMP_THRESHOLD: u32 = 14 * LEDGERS_PER_DAY; // ~14 days
const ROOT_BUMP_TO: u32 = 60 * LEDGERS_PER_DAY; // ~60 days

/// Verifying key stored on-chain (our trusted setup). Set by admin.
#[contracttype]
#[derive(Clone)]
pub struct VkData {
    pub alpha1: BytesN<96>,
    pub beta2: BytesN<192>,
    pub gamma2: BytesN<192>,
    pub delta2: BytesN<192>,
    pub ic: Vec<BytesN<96>>,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Token(u32), // token_id -> SAC address (0 = USDC, 1 = XLM)
    Vk,
    Paused,
    Index,
    Nullifier(BytesN<32>),
    Root(BytesN<32>),
    RootRing(u32), // ring buffer slot -> root, for eviction
    RootHead,      // next ring slot
    // Shielded pool. Separate verifying key from Vk, because the join-split
    // circuit has 8 public inputs against claim's 6, so one key cannot serve
    // both. Appended last so existing stored entries keep their encoding.
    PoolVk,
}

#[contracterror]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    NotAuthorized = 3,
    Paused = 4,
    UnknownRoot = 5,
    NullifierUsed = 6,
    InvalidProof = 7,
    VkNotSet = 8,
    NonCanonicalInput = 9,
    InvalidAmount = 10,
    UnknownToken = 11,
    /// Wrong number of nullifiers or output commitments for the join-split.
    InvalidShape = 12,
}

/// Groth16 proof bytes, in the same encoding `claim` takes as three separate
/// arguments. Bundled here because Soroban caps contract functions at 10
/// parameters and `transact` needs the room.
#[contracttype]
#[derive(Clone)]
pub struct ProofBytes {
    pub a: BytesN<96>,
    pub b: BytesN<192>,
    pub c: BytesN<96>,
}

/// Join-split shape. Must match `JoinSplit(20, 64, N_IN, N_OUT)` in
/// circuits/src/joinsplit.circom. The verifying key's IC length is derived
/// from these, so a mismatch is caught by `verifier::verify` rather than
/// silently accepted.
const POOL_N_IN: u32 = 2;
const POOL_N_OUT: u32 = 2;

/// BLS12-381 scalar field modulus r, big-endian. A `nullifier`/`root` is used
/// both as a storage key (raw 32 bytes) AND, via `Fr::from_bytes`, as a proof
/// public input. `Fr::from_bytes` reduces mod r, so `n` and `n + r` yield the
/// SAME field element (identical proof) but DIFFERENT storage keys — a
/// double-spend. Rejecting any 32-byte value >= r forces one canonical
/// encoding per field element, closing that gap.
const BLS_R_BE: [u8; 32] = [
    0x73, 0xed, 0xa7, 0x53, 0x29, 0x9d, 0x7d, 0x48, 0x33, 0x39, 0xd8, 0x08, 0x09, 0xa1, 0xd8, 0x05,
    0x53, 0xbd, 0xa4, 0x02, 0xff, 0xfe, 0x5b, 0xfe, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
];

/// True iff the big-endian 32-byte value is a canonical field element (< r).
fn is_canonical_fr(b: &BytesN<32>) -> bool {
    let x = b.to_array();
    let mut i = 0usize;
    while i < 32 {
        if x[i] < BLS_R_BE[i] {
            return true;
        }
        if x[i] > BLS_R_BE[i] {
            return false;
        }
        i += 1;
    }
    false // exactly equal to r is non-canonical (== 0 mod r)
}

#[contract]
pub struct ZeekPay;

#[contractimpl]
impl ZeekPay {
    pub fn initialize(env: Env, admin: Address, usdc_sac: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token(0), &usdc_sac);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::Index, &0u64);
        env.storage().instance().set(&DataKey::RootHead, &0u32);
        Ok(())
    }

    /// Register an additional token. Admin only. tokenId 0 is set by initialize.
    pub fn add_token(env: Env, token_id: u32, sac_address: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Token(token_id), &sac_address);
        Ok(())
    }

    pub fn set_vk(env: Env, vk: VkData) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Vk, &vk);
        Ok(())
    }

    /// Verifying key for the shielded-pool join-split circuit. Admin only.
    /// Separate from `set_vk`: rotating one must not disturb the other while
    /// both paths are live during migration.
    pub fn set_pool_vk(env: Env, vk: VkData) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::PoolVk, &vk);
        Ok(())
    }

    /// Replace this contract's code, keeping its address and all stored state:
    /// nullifiers, roots, the token registry, and both verifying keys.
    ///
    /// Without this, fixing a bug means deploying a fresh contract at a new
    /// address, which strands every note already deposited, drops the posted
    /// roots, and forces a config change across the resolver, the backend and
    /// the frontend. That is how the amount-truncation fix would otherwise have
    /// had to ship.
    ///
    /// TRUST NOTE, and it is a real one: the admin can swap in arbitrary code
    /// and therefore has full control of pooled funds. That is a stronger power
    /// than `set_vk` or `set_paused` and it does not expire. It sits alongside
    /// the existing admin-posts-roots seam documented in README honest-limits,
    /// but it is worse: a malicious or compromised admin key can drain the
    /// contract outright. Before mainnet this wants either a timelock, a
    /// multisig admin, or removal of the entry point entirely once the code is
    /// audited and stable.
    ///
    /// Deliberately NOT gated on `paused`: the point is to fix a contract that
    /// has been paused precisely because something is wrong with it.
    ///
    /// `new_wasm_hash` is the hash of an already-uploaded wasm, from
    /// `stellar contract upload`. The upgrade takes effect after this call
    /// returns.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    /// Publish an off-chain-computed Merkle root. Admin/relayer only.
    pub fn post_root(env: Env, root: BytesN<32>) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if env.storage().persistent().has(&DataKey::Root(root.clone())) {
            return Ok(());
        }
        // Ring buffer: evict the oldest root once full, so storage is bounded.
        let head: u32 = env.storage().instance().get(&DataKey::RootHead).unwrap_or(0);
        let slot = head % ROOT_WINDOW;
        if let Some(old) = env
            .storage()
            .persistent()
            .get::<_, BytesN<32>>(&DataKey::RootRing(slot))
        {
            env.storage().persistent().remove(&DataKey::Root(old));
        }
        env.storage()
            .persistent()
            .set(&DataKey::RootRing(slot), &root);
        env.storage()
            .persistent()
            .set(&DataKey::Root(root.clone()), &true);
        // Keep the root (and its ring slot) live at least as long as its window.
        env.storage().persistent().extend_ttl(
            &DataKey::Root(root.clone()),
            ROOT_BUMP_THRESHOLD,
            ROOT_BUMP_TO,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::RootRing(slot),
            ROOT_BUMP_THRESHOLD,
            ROOT_BUMP_TO,
        );
        env.storage()
            .instance()
            .set(&DataKey::RootHead, &head.wrapping_add(1));
        Ok(())
    }

    /// Deposit a note. Pulls `amount` stroops of the specified token from `from`
    /// into the contract pool and records the commitment. Emits Deposit (NO
    /// sender, NO amount, NO token — all visible from the SAC transfer).
    pub fn deposit(
        env: Env,
        from: Address,
        amount: i128,
        commitment: BytesN<32>,
        token_id: u32,
    ) -> Result<u64, Error> {
        Self::require_initialized(&env)?;
        if Self::is_paused(&env) {
            return Err(Error::Paused);
        }
        if amount <= 0 || amount >= AMOUNT_MAX_EXCLUSIVE {
            return Err(Error::InvalidAmount);
        }
        from.require_auth();

        let tok_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token(token_id))
            .ok_or(Error::UnknownToken)?;
        let client = token::Client::new(&env, &tok_addr);
        client.transfer(&from, &env.current_contract_address(), &amount);

        let index: u64 = env.storage().instance().get(&DataKey::Index).unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::Index, &(index + 1));

        env.events().publish(
            (soroban_sdk::symbol_short!("deposit"),),
            (commitment, index),
        );
        Ok(index)
    }

    /// Claim a note. Verifies the Groth16 proof binding {root, nullifier,
    /// recipientDigest, amount, tokenId}; rejects replayed nullifiers and
    /// unknown roots; pays the recipient in the correct token.
    ///
    /// `recipient_digest` is the proof-bound identity commitment. For stealth
    /// payments it is ECDH-derived (unique per payment), so the contract does
    /// NOT re-derive it from `recipient`. The caller (claimer) supplies it and
    /// the proof must commit to it — a wrong digest simply fails verification.
    ///
    /// Emits Claim (NO commitment -> no link to a deposit, NO amount, NO token).
    pub fn claim(
        env: Env,
        proof_a: BytesN<96>,
        proof_b: BytesN<192>,
        proof_c: BytesN<96>,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        recipient_digest: BytesN<32>,
        recipient: Address,
        amount: i128,
        token_id: u32,
    ) -> Result<(), Error> {
        Self::require_initialized(&env)?;
        if Self::is_paused(&env) {
            return Err(Error::Paused);
        }
        if amount <= 0 || amount >= AMOUNT_MAX_EXCLUSIVE {
            return Err(Error::InvalidAmount);
        }
        // 0. Reject non-canonical field elements (>= r). Without this, a
        //    nullifier of `n + r` reduces to the same Fr as `n` (so the same
        //    proof verifies) yet stores under a different key -> double-spend.
        if !is_canonical_fr(&nullifier) || !is_canonical_fr(&root) {
            return Err(Error::NonCanonicalInput);
        }
        // 1. Root must be one the contract knows.
        if !env.storage().persistent().has(&DataKey::Root(root.clone())) {
            return Err(Error::UnknownRoot);
        }
        // 2. Nullifier must be unused (check-then-set; never expires).
        if env
            .storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier.clone()))
        {
            return Err(Error::NullifierUsed);
        }
        // 3. Reject non-canonical recipient_digest (same reasoning as nullifier).
        if !is_canonical_fr(&recipient_digest) {
            return Err(Error::NonCanonicalInput);
        }
        // 4. Verify the proof (real). The test-only bypass below is excluded
        //    from the wasm build (cfg(test)) and cannot ship.
        if !Self::maybe_skip_verify(&env) {
            let proof = Proof {
                a: G1Affine::from_bytes(proof_a),
                b: G2Affine::from_bytes(proof_b),
                c: G1Affine::from_bytes(proof_c),
            };
            let vk = Self::load_vk(&env)?;
            let pubs = Self::derive_public_inputs(&env, &root, &nullifier, &recipient_digest, amount, token_id);
            if !verifier::verify(&env, &vk, &proof, &pubs) {
                return Err(Error::InvalidProof);
            }
        }
        // 5. Mark nullifier used (after verify, before payout). Bump its TTL so
        //    it is never reaped while unattended: a reaped nullifier = double-spend.
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(nullifier.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Nullifier(nullifier.clone()),
            NULLIFIER_BUMP_THRESHOLD,
            NULLIFIER_BUMP_TO,
        );
        // 6. Pay recipient in the correct token.
        let tok_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token(token_id))
            .ok_or(Error::UnknownToken)?;
        let client = token::Client::new(&env, &tok_addr);
        client.transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );
        env.events().publish(
            (soroban_sdk::symbol_short!("claim"),),
            (nullifier,),
        );
        Ok(())
    }

    /// Shielded-pool spend (join-split). One entry point covers all three
    /// shapes: a deposit is a spend with dummy inputs, a withdrawal is one
    /// whose value leaves the pool, and an in-pool transfer sets both public
    /// legs to zero and reveals no amount at all.
    ///
    /// Verifies the join-split proof binding
    /// [root, nullifiers, out_commitments, public_deposit, public_withdraw,
    /// token_id], which includes the in-circuit balance constraint
    /// `sum(inputs) + deposit == sum(outputs) + withdraw`. That constraint is
    /// what stops the pool paying out more than was put in, and it is the fix
    /// for deposits not being bound to their commitments in `deposit`/`claim`.
    ///
    /// Emits the output commitments with their tree indices so the indexer can
    /// advance the Merkle tree off-chain, matching the existing `post_root`
    /// trust seam.
    pub fn transact(
        env: Env,
        proof: ProofBytes,
        root: BytesN<32>,
        nullifiers: Vec<BytesN<32>>,
        out_commitments: Vec<BytesN<32>>,
        public_deposit: i128,
        public_withdraw: i128,
        token_id: u32,
        depositor: Address,
        recipient: Address,
    ) -> Result<u64, Error> {
        Self::require_initialized(&env)?;
        if Self::is_paused(&env) {
            return Err(Error::Paused);
        }

        // Shape must match the circuit the verifying key was built for. A
        // mismatch would also be caught by verifier::verify's IC length check,
        // but failing here gives a usable error instead of InvalidProof.
        if nullifiers.len() != POOL_N_IN || out_commitments.len() != POOL_N_OUT {
            return Err(Error::InvalidShape);
        }

        // Public legs may be zero (an in-pool transfer moves nothing on-chain),
        // but never negative, and never at or above 2^64. See
        // AMOUNT_MAX_EXCLUSIVE: derive_pool_public_inputs truncates via
        // `as u64` exactly as derive_public_inputs does, so without this bound
        // a proof for X would authorise moving 2^64 + X.
        if public_deposit < 0
            || public_withdraw < 0
            || public_deposit >= AMOUNT_MAX_EXCLUSIVE
            || public_withdraw >= AMOUNT_MAX_EXCLUSIVE
        {
            return Err(Error::InvalidAmount);
        }

        // Reject non-canonical field elements everywhere a 32-byte value is
        // used both as a storage key and as a proof input. Same reasoning as
        // claim: n and n + r are one field element but two storage keys.
        if !is_canonical_fr(&root) {
            return Err(Error::NonCanonicalInput);
        }
        let mut i = 0u32;
        while i < nullifiers.len() {
            if !is_canonical_fr(&nullifiers.get(i).unwrap()) {
                return Err(Error::NonCanonicalInput);
            }
            i += 1;
        }
        let mut j = 0u32;
        while j < out_commitments.len() {
            if !is_canonical_fr(&out_commitments.get(j).unwrap()) {
                return Err(Error::NonCanonicalInput);
            }
            j += 1;
        }

        if !env.storage().persistent().has(&DataKey::Root(root.clone())) {
            return Err(Error::UnknownRoot);
        }

        // Verify before touching any state.
        if !Self::maybe_skip_verify(&env) {
            let proof = Proof {
                a: G1Affine::from_bytes(proof.a),
                b: G2Affine::from_bytes(proof.b),
                c: G1Affine::from_bytes(proof.c),
            };
            let vk = Self::load_vk_at(&env, DataKey::PoolVk)?;
            let pubs = Self::derive_pool_public_inputs(
                &env,
                &root,
                &nullifiers,
                &out_commitments,
                public_deposit,
                public_withdraw,
                token_id,
            );
            if !verifier::verify(&env, &vk, &proof, &pubs) {
                return Err(Error::InvalidProof);
            }
        }

        // SECURITY: check-then-set, one nullifier at a time. The circuit does
        // NOT constrain the two nullifiers to differ (see the note at the
        // bottom of joinsplit.circom), so a prover can pass the same note
        // twice. Checking both against storage first and only then writing
        // both would let that duplicate through: neither is stored at check
        // time, and the second write silently overwrites the first. Writing
        // each before checking the next is what makes the in-transaction
        // duplicate impossible. Do not reorder this loop.
        let mut k = 0u32;
        while k < nullifiers.len() {
            let n = nullifiers.get(k).unwrap();
            if env.storage().persistent().has(&DataKey::Nullifier(n.clone())) {
                return Err(Error::NullifierUsed);
            }
            env.storage()
                .persistent()
                .set(&DataKey::Nullifier(n.clone()), &true);
            env.storage().persistent().extend_ttl(
                &DataKey::Nullifier(n),
                NULLIFIER_BUMP_THRESHOLD,
                NULLIFIER_BUMP_TO,
            );
            k += 1;
        }

        // Publish the new notes with their tree positions. The indexer rebuilds
        // the tree from these and the admin posts the resulting root, so an
        // output note is only spendable once that has happened.
        let mut index: u64 = env.storage().instance().get(&DataKey::Index).unwrap_or(0);
        let first_index = index;
        let mut m = 0u32;
        while m < out_commitments.len() {
            env.events().publish(
                (soroban_sdk::symbol_short!("note"),),
                (out_commitments.get(m).unwrap(), index),
            );
            index += 1;
            m += 1;
        }
        env.storage().instance().set(&DataKey::Index, &index);

        // Token legs. Pull first, so a deposit in the same transaction can fund
        // the withdrawal alongside it.
        let tok_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token(token_id))
            .ok_or(Error::UnknownToken)?;
        let client = token::Client::new(&env, &tok_addr);
        if public_deposit > 0 {
            depositor.require_auth();
            client.transfer(&depositor, &env.current_contract_address(), &public_deposit);
        }
        if public_withdraw > 0 {
            client.transfer(
                &env.current_contract_address(),
                &recipient,
                &public_withdraw,
            );
        }

        Ok(first_index)
    }

    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }

    pub fn is_known_root(env: Env, root: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Root(root))
    }

    // ---- internal helpers ----

    fn require_initialized(env: &Env) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    fn load_vk(env: &Env) -> Result<VerifyingKey, Error> {
        Self::load_vk_at(env, DataKey::Vk)
    }

    fn load_vk_at(env: &Env, key: DataKey) -> Result<VerifyingKey, Error> {
        let vk: VkData = env
            .storage()
            .instance()
            .get(&key)
            .ok_or(Error::VkNotSet)?;
        let mut ic: Vec<G1Affine> = Vec::new(env);
        let mut i = 0u32;
        while i < vk.ic.len() {
            ic.push_back(G1Affine::from_bytes(vk.ic.get(i).unwrap()));
            i += 1;
        }
        Ok(VerifyingKey {
            alpha1: G1Affine::from_bytes(vk.alpha1),
            beta2: G2Affine::from_bytes(vk.beta2),
            gamma2: G2Affine::from_bytes(vk.gamma2),
            delta2: G2Affine::from_bytes(vk.delta2),
            ic,
        })
    }

    /// Public inputs the proof must commit to, in this exact order. The
    /// circom-circuit feature MUST match this encoding:
    ///   [ Fr(root), Fr(nullifier), Fr(recipient_digest), Fr(amount), Fr(tokenId) ]
    ///
    /// `recipient_digest` is now caller-supplied (stealth derivation): the sender
    /// computes it via ECDH so each payment has a unique digest even to the same
    /// recipient. The contract no longer re-derives it from the claim address.
    /// A wrong digest simply fails proof verification (the proof commits to it).
    ///
    /// amount is the raw stroop value (always positive, fits in u64 for any
    /// realistic payment). tokenId is a small uint (0 = USDC, 1 = XLM).
    fn derive_public_inputs(
        env: &Env,
        root: &BytesN<32>,
        nullifier: &BytesN<32>,
        recipient_digest: &BytesN<32>,
        amount: i128,
        token_id: u32,
    ) -> Vec<Fr> {
        let mut v: Vec<Fr> = Vec::new(env);
        v.push_back(Fr::from_bytes(root.clone()));
        v.push_back(Fr::from_bytes(nullifier.clone()));
        v.push_back(Fr::from_bytes(recipient_digest.clone()));
        v.push_back(Fr::from_u256(soroban_sdk::U256::from_parts(env, 0, 0, 0, amount as u64)));
        v.push_back(Fr::from_u256(soroban_sdk::U256::from_parts(env, 0, 0, 0, token_id as u64)));
        v
    }

    /// Public inputs for the join-split, in the order locked by
    /// `component main {public [...]}` in circuits/src/joinsplit.circom:
    ///   [root, nullifiers.., out_commitments.., deposit, withdraw, tokenId]
    /// Never insert or reorder; append only, and only alongside the circuit.
    fn derive_pool_public_inputs(
        env: &Env,
        root: &BytesN<32>,
        nullifiers: &Vec<BytesN<32>>,
        out_commitments: &Vec<BytesN<32>>,
        public_deposit: i128,
        public_withdraw: i128,
        token_id: u32,
    ) -> Vec<Fr> {
        let mut v: Vec<Fr> = Vec::new(env);
        v.push_back(Fr::from_bytes(root.clone()));
        let mut i = 0u32;
        while i < nullifiers.len() {
            v.push_back(Fr::from_bytes(nullifiers.get(i).unwrap()));
            i += 1;
        }
        let mut j = 0u32;
        while j < out_commitments.len() {
            v.push_back(Fr::from_bytes(out_commitments.get(j).unwrap()));
            j += 1;
        }
        // `as u64` truncates, which is safe only because transact() rejects
        // anything at or above AMOUNT_MAX_EXCLUSIVE first. Both halves stay.
        v.push_back(Fr::from_u256(soroban_sdk::U256::from_parts(
            env,
            0,
            0,
            0,
            public_deposit as u64,
        )));
        v.push_back(Fr::from_u256(soroban_sdk::U256::from_parts(
            env,
            0,
            0,
            0,
            public_withdraw as u64,
        )));
        v.push_back(Fr::from_u256(soroban_sdk::U256::from_parts(
            env,
            0,
            0,
            0,
            token_id as u64,
        )));
        v
    }

    // verify bypass: real in wasm, test-controllable in unit tests only.
    #[cfg(not(test))]
    fn maybe_skip_verify(_env: &Env) -> bool {
        false
    }
    #[cfg(test)]
    fn maybe_skip_verify(env: &Env) -> bool {
        test_support::skip(env)
    }
}

#[cfg(test)]
mod test_support {
    use super::*;
    #[contracttype]
    pub enum TestKey {
        SkipVerify,
    }
    pub fn set_skip(env: &Env, skip: bool) {
        env.storage().instance().set(&TestKey::SkipVerify, &skip);
    }
    pub fn skip(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&TestKey::SkipVerify)
            .unwrap_or(false)
    }
}
