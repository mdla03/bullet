//! ZeekPay main contract — Option B (off-chain Merkle).
//!
//! deposit: pull fixed-denomination USDC, store commitment, emit event (cheap).
//! post_root: admin/relayer publishes an off-chain-computed Merkle root (the
//!   Option-B trust seam — documented in README honest-limits).
//! claim: verify a Groth16 proof (real, BLS12-381 host fns) that the caller owns
//!   a note in the tree under a known root, with {root, nullifier, recipient,
//!   denom} bound as public inputs; reject replayed nullifiers; pay the recipient.
//!
//! SECURITY-SENSITIVE: nullifier replay = double-spend; recipient+denom binding
//! prevents front-running / denom-mismatch drains; only contract-known roots are
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

const USDC_DECIMALS: i128 = 10_000_000; // 7 decimals on Stellar
const ROOT_WINDOW: u32 = 64; // recent valid roots kept

#[contracttype]
#[derive(Clone, Copy, PartialEq)]
pub enum Denom {
    One,
    Ten,
    Fifty,
    Hundred,
}

impl Denom {
    fn amount(&self) -> i128 {
        match self {
            Denom::One => USDC_DECIMALS,
            Denom::Ten => 10 * USDC_DECIMALS,
            Denom::Fifty => 50 * USDC_DECIMALS,
            Denom::Hundred => 100 * USDC_DECIMALS,
        }
    }
    fn as_u32(&self) -> u32 {
        match self {
            Denom::One => 1,
            Denom::Ten => 10,
            Denom::Fifty => 50,
            Denom::Hundred => 100,
        }
    }
}

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
        env.storage()
            .instance()
            .set(&DataKey::RootHead, &head.wrapping_add(1));
        Ok(())
    }

    /// Deposit a fixed-denomination note. Pulls `denom` USDC from `from` into the
    /// contract pool and records the commitment. Emits Deposit (NO sender).
    pub fn deposit(
        env: Env,
        from: Address,
        denom: Denom,
        commitment: BytesN<32>,
    ) -> Result<u64, Error> {
        Self::require_initialized(&env)?;
        if Self::is_paused(&env) {
            return Err(Error::Paused);
        }
        from.require_auth();

        let usdc: Address = env.storage().instance().get(&DataKey::Usdc).unwrap();
        let client = token::Client::new(&env, &usdc);
        client.transfer(&from, &env.current_contract_address(), &denom.amount());

        let index: u64 = env.storage().instance().get(&DataKey::Index).unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::Index, &(index + 1));

        // Deposit event carries commitment + denom + index, NEVER the sender.
        env.events().publish(
            (soroban_sdk::symbol_short!("deposit"),),
            (commitment, denom.as_u32(), index),
        );
        Ok(index)
    }

    /// Claim a note. Verifies the Groth16 proof binding {root, nullifier,
    /// recipient, denom}; rejects replayed nullifiers and unknown roots; pays
    /// the recipient. Emits Claim (NO commitment -> no link to a deposit).
    pub fn claim(
        env: Env,
        proof_a: BytesN<96>,
        proof_b: BytesN<192>,
        proof_c: BytesN<96>,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        recipient: Address,
        denom: Denom,
    ) -> Result<(), Error> {
        Self::require_initialized(&env)?;
        if Self::is_paused(&env) {
            return Err(Error::Paused);
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
            let pubs = Self::derive_public_inputs(&env, &root, &nullifier, &recipient, &denom);
            if !verifier::verify(&env, &vk, &proof, &pubs) {
                return Err(Error::InvalidProof);
            }
        }
        // 4. Mark nullifier used (after verify, before payout).
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(nullifier.clone()), &true);
        // 5. Pay recipient.
        let usdc: Address = env.storage().instance().get(&DataKey::Usdc).unwrap();
        let client = token::Client::new(&env, &usdc);
        client.transfer(
            &env.current_contract_address(),
            &recipient,
            &denom.amount(),
        );
        env.events().publish(
            (soroban_sdk::symbol_short!("claim"),),
            (nullifier, denom.as_u32()),
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
    ///   [ Fr(root), Fr(nullifier), Fr(recipient_digest), Fr(denom) ]
    /// recipient_digest = sha256(recipient.to_xdr) with the top byte zeroed so
    /// the 256-bit digest is < the BLS scalar field r.
    fn derive_public_inputs(
        env: &Env,
        root: &BytesN<32>,
        nullifier: &BytesN<32>,
        recipient: &Address,
        denom: &Denom,
    ) -> Vec<Fr> {
        let mut v: Vec<Fr> = Vec::new(env);
        v.push_back(Fr::from_bytes(root.clone()));
        v.push_back(Fr::from_bytes(nullifier.clone()));
        v.push_back(Self::recipient_fr(env, recipient));
        v.push_back(Fr::from_u256(soroban_sdk::U256::from_u32(env, denom.as_u32())));
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
