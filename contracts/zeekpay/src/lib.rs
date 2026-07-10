//! ZeekPay main contract — Option B (off-chain Merkle).
//!
//! deposit: pull USDC from `from`, store commitment, emit event (cheap).
//! post_root: admin/relayer publishes an off-chain-computed Merkle root (the
//!   Option-B trust seam — documented in README honest-limits).
//! claim: verify a Groth16 proof (real, BLS12-381 host fns) that the caller owns
//!   a note in the tree under a known root, with {root, nullifier, recipient,
//!   amount} bound as public inputs; reject replayed nullifiers; pay the recipient.
//!
//! SECURITY-SENSITIVE: nullifier replay = double-spend; recipient+amount binding
//! prevents front-running / amount-mismatch drains; only contract-known roots are
//! accepted. See src/test.rs for the verifier correctness test against a real
//! snarkjs proof and the adversarial business-logic tests.
#![no_std]

#[cfg(test)]
extern crate std;

mod verifier;

#[cfg(test)]
mod groth16_fixture;
#[cfg(test)]
mod test;

use soroban_sdk::crypto::bls12_381::{Fr, G1Affine, G2Affine};
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Vec,
};

use verifier::{Proof, VerifyingKey};

const ROOT_WINDOW: u32 = 64; // recent valid roots kept

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
    Usdc,
    Vk,
    Paused,
    Index,
    Nullifier(BytesN<32>),
    Root(BytesN<32>),
    RootRing(u32), // ring buffer slot -> root, for eviction
    RootHead,      // next ring slot
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
}

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
        env.storage().instance().set(&DataKey::Usdc, &usdc_sac);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::Index, &0u64);
        env.storage().instance().set(&DataKey::RootHead, &0u32);
        Ok(())
    }

    pub fn set_vk(env: Env, vk: VkData) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Vk, &vk);
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

    /// Deposit a note. Pulls `amount` stroops of USDC from `from` into the
    /// contract pool and records the commitment. Emits Deposit (NO sender, NO amount).
    pub fn deposit(
        env: Env,
        from: Address,
        amount: i128,
        commitment: BytesN<32>,
    ) -> Result<u64, Error> {
        Self::require_initialized(&env)?;
        if Self::is_paused(&env) {
            return Err(Error::Paused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        from.require_auth();

        let usdc: Address = env.storage().instance().get(&DataKey::Usdc).unwrap();
        let client = token::Client::new(&env, &usdc);
        client.transfer(&from, &env.current_contract_address(), &amount);

        let index: u64 = env.storage().instance().get(&DataKey::Index).unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::Index, &(index + 1));

        // Deposit event carries commitment + index only. Amount is not emitted:
        // it is already visible from the SAC transfer and adding it here would
        // make event scraping trivially link deposit size to the commitment.
        env.events().publish(
            (soroban_sdk::symbol_short!("deposit"),),
            (commitment, index),
        );
        Ok(index)
    }

    /// Claim a note. Verifies the Groth16 proof binding {root, nullifier,
    /// recipient, amount}; rejects replayed nullifiers and unknown roots; pays
    /// the recipient. Emits Claim (NO commitment -> no link to a deposit, NO amount).
    pub fn claim(
        env: Env,
        proof_a: BytesN<96>,
        proof_b: BytesN<192>,
        proof_c: BytesN<96>,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        recipient: Address,
        amount: i128,
    ) -> Result<(), Error> {
        Self::require_initialized(&env)?;
        if Self::is_paused(&env) {
            return Err(Error::Paused);
        }
        if amount <= 0 {
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
        // 3. Verify the proof (real). The test-only bypass below is excluded
        //    from the wasm build (cfg(test)) and cannot ship.
        if !Self::maybe_skip_verify(&env) {
            let proof = Proof {
                a: G1Affine::from_bytes(proof_a),
                b: G2Affine::from_bytes(proof_b),
                c: G1Affine::from_bytes(proof_c),
            };
            let vk = Self::load_vk(&env)?;
            let pubs = Self::derive_public_inputs(&env, &root, &nullifier, &recipient, amount);
            if !verifier::verify(&env, &vk, &proof, &pubs) {
                return Err(Error::InvalidProof);
            }
        }
        // 4. Mark nullifier used (after verify, before payout). Bump its TTL so
        //    it is never reaped while unattended: a reaped nullifier = double-spend.
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(nullifier.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Nullifier(nullifier.clone()),
            NULLIFIER_BUMP_THRESHOLD,
            NULLIFIER_BUMP_TO,
        );
        // 5. Pay recipient.
        let usdc: Address = env.storage().instance().get(&DataKey::Usdc).unwrap();
        let client = token::Client::new(&env, &usdc);
        client.transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );
        // Claim event carries nullifier only. Amount omitted: the SAC transfer
        // already records it, and repeating it here aids amount-linkage analysis.
        env.events().publish(
            (soroban_sdk::symbol_short!("claim"),),
            (nullifier,),
        );
        Ok(())
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
        let vk: VkData = env
            .storage()
            .instance()
            .get(&DataKey::Vk)
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
    ///   [ Fr(root), Fr(nullifier), Fr(recipient_digest), Fr(amount) ]
    /// recipient_digest = sha256(recipient.to_xdr) with the top byte zeroed so
    /// the 256-bit digest is < the BLS scalar field r.
    /// amount is the raw stroop value (always positive, fits in u64 for any
    /// realistic payment).
    fn derive_public_inputs(
        env: &Env,
        root: &BytesN<32>,
        nullifier: &BytesN<32>,
        recipient: &Address,
        amount: i128,
    ) -> Vec<Fr> {
        let mut v: Vec<Fr> = Vec::new(env);
        v.push_back(Fr::from_bytes(root.clone()));
        v.push_back(Fr::from_bytes(nullifier.clone()));
        v.push_back(Self::recipient_fr(env, recipient));
        // amount fits in u64 for any realistic payment; map into the lo_lo word.
        v.push_back(Fr::from_u256(soroban_sdk::U256::from_parts(env, 0, 0, 0, amount as u64)));
        v
    }

    fn recipient_fr(env: &Env, recipient: &Address) -> Fr {
        let xdr = recipient.clone().to_xdr(env);
        let digest = env.crypto().sha256(&xdr);
        let mut bytes = digest.to_array();
        bytes[0] = 0; // ensure < r (BLS scalar field is ~255 bits)
        Fr::from_bytes(BytesN::from_array(env, &bytes))
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
