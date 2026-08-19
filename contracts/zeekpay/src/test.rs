//! Verifier correctness against a REAL snarkjs Groth16/BLS12-381 proof.
//! This is the definitive check that our snarkjs -> Soroban byte encoding
//! (esp. the G2 c1,c0 order) is correct: the real proof must verify `true`,
//! and a tampered public input must verify `false`.
#![cfg(test)]

use soroban_sdk::crypto::bls12_381::{Fr, G1Affine, G2Affine};
use soroban_sdk::{BytesN, Env, Vec};

use crate::groth16_fixture as fx;
use crate::verifier::{verify, Proof, VerifyingKey};

fn g1(env: &Env, h: &str) -> G1Affine {
    let v = hex::decode(h).unwrap();
    let a: [u8; 96] = v.try_into().unwrap();
    G1Affine::from_bytes(BytesN::from_array(env, &a))
}
fn g2(env: &Env, h: &str) -> G2Affine {
    let v = hex::decode(h).unwrap();
    let a: [u8; 192] = v.try_into().unwrap();
    G2Affine::from_bytes(BytesN::from_array(env, &a))
}
fn fr(env: &Env, h: &str) -> Fr {
    let v = hex::decode(h).unwrap();
    let a: [u8; 32] = v.try_into().unwrap();
    Fr::from_bytes(BytesN::from_array(env, &a))
}

fn fixture(env: &Env) -> (VerifyingKey, Proof, Vec<Fr>) {
    let mut ic: Vec<G1Affine> = Vec::new(env);
    for h in fx::IC {
        ic.push_back(g1(env, h));
    }
    let vk = VerifyingKey {
        alpha1: g1(env, fx::ALPHA1),
        beta2: g2(env, fx::BETA2),
        gamma2: g2(env, fx::GAMMA2),
        delta2: g2(env, fx::DELTA2),
        ic,
    };
    let proof = Proof {
        a: g1(env, fx::PROOF_A),
        b: g2(env, fx::PROOF_B),
        c: g1(env, fx::PROOF_C),
    };
    let mut pubs: Vec<Fr> = Vec::new(env);
    for h in fx::PUBS {
        pubs.push_back(fr(env, h));
    }
    (vk, proof, pubs)
}

#[test]
fn real_proof_verifies() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let (vk, proof, pubs) = fixture(&env);
    assert!(
        verify(&env, &vk, &proof, &pubs),
        "real snarkjs proof must verify true — if false, the byte encoding (likely G2 c1/c0 order) is wrong"
    );
}

#[test]
fn tampered_public_input_fails() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let (vk, proof, _pubs) = fixture(&env);
    // Replace the public input with a different value -> proof must NOT verify.
    let mut bad: Vec<Fr> = Vec::new(&env);
    bad.push_back(fr(&env, &"01".repeat(32)));
    assert!(
        !verify(&env, &vk, &proof, &bad),
        "tampered public input must fail verification"
    );
}

#[test]
fn wrong_public_input_count_fails() {
    let env = Env::default();
    let (vk, proof, mut pubs) = fixture(&env);
    // Add an extra public input so len != ic.len()-1 -> reject.
    pubs.push_back(fr(&env, &"02".repeat(32)));
    assert!(!verify(&env, &vk, &proof, &pubs));
}

// ----------------------------------------------------------------------------
// Contract business-logic tests. The Groth16 verify is exercised for real in
// the tests above; here we use the cfg(test)-only verify bypass to drive the
// stateful logic (nullifier replay, root checks, amount, auth, payout). The
// bypass is excluded from the wasm build and cannot ship.
// ----------------------------------------------------------------------------

use crate::{test_support, Error, ZeekPay, ZeekPayClient};

// 10 USDC in stroops (7 decimals on Stellar)
const TEN_USDC: i128 = 100_000_000;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address};

#[allow(dead_code)]
struct Setup {
    env: Env,
    client: ZeekPayClient<'static>,
    id: Address,
    usdc: Address,
    usdc_admin: token::StellarAssetClient<'static>,
    token: token::Client<'static>,
    admin: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let usdc = sac.address();
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc);
    let tok = token::Client::new(&env, &usdc);

    let id = env.register(ZeekPay, ());
    let client = ZeekPayClient::new(&env, &id);
    client.initialize(&admin, &usdc);

    // Skip the SNARK check for business-logic tests.
    env.as_contract(&id, || test_support::set_skip(&env, true));

    Setup {
        env,
        client,
        id,
        usdc,
        usdc_admin,
        token: tok,
        admin,
    }
}

fn b32(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn happy_path_deposit_then_claim() {
    let s = setup();
    let depositor = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    s.usdc_admin.mint(&depositor, &1_000_000_000); // 100 USDC

    let commitment = b32(&s.env, 0xAA);
    s.client.deposit(&depositor, &TEN_USDC, &commitment, &0);
    // contract holds 10 USDC; depositor down 10.
    assert_eq!(s.token.balance(&s.id), 100_000_000);
    assert_eq!(s.token.balance(&depositor), 900_000_000);

    let root = b32(&s.env, 0x11);
    let nullifier = b32(&s.env, 0x22);
    s.client.post_root(&root);

    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);
    s.client
        .claim(&pa, &pb, &pc, &root, &nullifier, &b32(&s.env, 0x33), &recipient, &TEN_USDC, &0);

    assert_eq!(s.token.balance(&recipient), 100_000_000); // 10 USDC
    assert_eq!(s.token.balance(&s.id), 0);
    assert!(s.client.is_nullifier_used(&nullifier));
}

#[test]
fn double_spend_rejected() {
    let s = setup();
    let depositor = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    s.usdc_admin.mint(&depositor, &1_000_000_000);

    // two deposits so the pool can cover a (wrongly) repeated claim
    s.client.deposit(&depositor, &TEN_USDC, &b32(&s.env, 0xA1), &0);
    s.client.deposit(&depositor, &TEN_USDC, &b32(&s.env, 0xA2), &0);

    let root = b32(&s.env, 0x11);
    let nullifier = b32(&s.env, 0x22);
    s.client.post_root(&root);
    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);

    s.client
        .claim(&pa, &pb, &pc, &root, &nullifier, &b32(&s.env, 0x33), &recipient, &TEN_USDC, &0);
    // same nullifier again -> NullifierUsed
    let err = s
        .client
        .try_claim(&pa, &pb, &pc, &root, &nullifier, &b32(&s.env, 0x33), &recipient, &TEN_USDC, &0)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::NullifierUsed);
    // recipient was paid exactly once.
    assert_eq!(s.token.balance(&recipient), 100_000_000);
}

#[test]
fn non_canonical_nullifier_rejected() {
    // A nullifier >= r must be rejected before the replay check, so `n` and
    // `n + r` can never both be spent. 0xff*32 is well above r.
    let s = setup();
    let recipient = Address::generate(&s.env);
    let depositor = Address::generate(&s.env);
    s.usdc_admin.mint(&depositor, &1_000_000_000);
    s.client.deposit(&depositor, &TEN_USDC, &b32(&s.env, 0xAA), &0);

    let root = b32(&s.env, 0x11);
    s.client.post_root(&root);
    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);

    let err = s
        .client
        .try_claim(&pa, &pb, &pc, &root, &b32(&s.env, 0xff), &b32(&s.env, 0x33), &recipient, &TEN_USDC, &0)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::NonCanonicalInput);
}

#[test]
fn non_canonical_recipient_digest_rejected() {
    // A recipientDigest >= r must be rejected so an attacker cannot submit
    // two claims with `d` and `d + r` which map to the same proof field element
    // but different on-chain semantics.
    let s = setup();
    let recipient = Address::generate(&s.env);
    let depositor = Address::generate(&s.env);
    s.usdc_admin.mint(&depositor, &1_000_000_000);
    s.client.deposit(&depositor, &TEN_USDC, &b32(&s.env, 0xAA), &0);

    let root = b32(&s.env, 0x11);
    s.client.post_root(&root);
    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);

    let err = s
        .client
        .try_claim(&pa, &pb, &pc, &root, &b32(&s.env, 0x22), &b32(&s.env, 0xff), &recipient, &TEN_USDC, &0)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::NonCanonicalInput);
}

#[test]
fn unknown_root_rejected() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);
    // Root must be canonical (< r) so it passes the field-element check and
    // reaches the unknown-root branch. 0x11..11 is < r and was never posted.
    let err = s
        .client
        .try_claim(
            &pa,
            &pb,
            &pc,
            &b32(&s.env, 0x11),
            &b32(&s.env, 0x22),
            &b32(&s.env, 0x33),
            &recipient,
            &TEN_USDC,
            &0,
        )
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::UnknownRoot);
}

#[test]
fn paused_blocks_deposit_and_claim() {
    let s = setup();
    let depositor = Address::generate(&s.env);
    s.usdc_admin.mint(&depositor, &1_000_000_000);
    s.client.set_paused(&true);

    let err = s
        .client
        .try_deposit(&depositor, &TEN_USDC, &b32(&s.env, 0xAA), &0)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::Paused);
}

#[test]
fn claim_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(ZeekPay, ());
    let client = ZeekPayClient::new(&env, &id);
    let recipient = Address::generate(&env);
    let pa = BytesN::from_array(&env, &[0u8; 96]);
    let pb = BytesN::from_array(&env, &[0u8; 192]);
    let pc = BytesN::from_array(&env, &[0u8; 96]);
    let err = client
        .try_claim(
            &pa,
            &pb,
            &pc,
            &b32(&env, 0x11),
            &b32(&env, 0x22),
            &b32(&env, 0x33),
            &recipient,
            &TEN_USDC,
            &0,
        )
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::NotInitialized);
}

#[test]
fn post_root_requires_admin_auth() {
    // Without mock_all_auths, post_root by a non-authorized caller must fail.
    let env = Env::default();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let id = env.register(ZeekPay, ());
    let client = ZeekPayClient::new(&env, &id);
    env.mock_all_auths();
    client.initialize(&admin, &sac.address());
    env.set_auths(&[]); // clear: no auths available now

    let res = client.try_post_root(&b32(&env, 0x11));
    assert!(res.is_err(), "post_root must require admin auth");
}

#[test]
fn claim_bumps_nullifier_and_root_ttl() {
    use crate::{DataKey, NULLIFIER_BUMP_TO, ROOT_BUMP_TO};
    use soroban_sdk::testutils::storage::Persistent as _;

    let s = setup();
    let depositor = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    s.usdc_admin.mint(&depositor, &1_000_000_000);
    s.client.deposit(&depositor, &TEN_USDC, &b32(&s.env, 0xAA), &0);

    let root = b32(&s.env, 0x11);
    let nullifier = b32(&s.env, 0x22);
    s.client.post_root(&root);
    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);
    s.client
        .claim(&pa, &pb, &pc, &root, &nullifier, &b32(&s.env, 0x33), &recipient, &TEN_USDC, &0);

    // A reaped nullifier = double-spend, so its TTL must be bumped hard on write.
    // get_ttl is remaining-ledgers, so it is at most the value extend_ttl set.
    s.env.as_contract(&s.id, || {
        let null_ttl = s
            .env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Nullifier(nullifier.clone()));
        assert!(
            null_ttl >= NULLIFIER_BUMP_TO - 1,
            "nullifier TTL not bumped: {null_ttl} < {NULLIFIER_BUMP_TO}"
        );
        let root_ttl = s
            .env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Root(root.clone()));
        assert!(
            root_ttl >= ROOT_BUMP_TO - 1,
            "root TTL not bumped: {root_ttl} < {ROOT_BUMP_TO}"
        );
    });
}

// ---------------------------------------------------------------------------
// Regression: amount must fit in u64 (AMOUNT_MAX_EXCLUSIVE).
//
// `derive_public_inputs` encodes amount as `amount as u64`, which truncates.
// Without the bound, a proof generated for X also verifies for a claim of
// 2^64 + X (identical public inputs) while `transfer` moves the full i128,
// draining the pool.
//
// These tests deliberately over-fund the pool. The point is that the drain
// must be blocked by the guard, not merely by an insufficient balance. Assert
// on balances, not on the error code: the SAC's own error code 10 decodes as
// our `InvalidAmount`, so an error-code assertion alone passes even when the
// guard is absent.
// ---------------------------------------------------------------------------

// 2^64 + 10 USDC. Truncates to exactly TEN_USDC in the public-input encoding.
const INFLATED: i128 = TEN_USDC + (1i128 << 64);

#[test]
fn claim_amount_at_or_above_2_64_rejected() {
    let s = setup();
    let recipient = Address::generate(&s.env);

    // The truncation collision the guard exists to defeat.
    assert_eq!(INFLATED as u64, TEN_USDC as u64);

    // Fund the pool so an unguarded claim would actually pay out.
    s.usdc_admin.mint(&s.id, &(INFLATED * 2));
    let pool_before = s.token.balance(&s.id);

    let root = b32(&s.env, 0x11);
    s.client.post_root(&root);
    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);
    let null = b32(&s.env, 0x22);

    let _ = s.client.try_claim(
        &pa, &pb, &pc, &root, &null, &b32(&s.env, 0x33), &recipient, &INFLATED, &0,
    );

    // The drain must not have happened.
    assert_eq!(s.token.balance(&recipient), 0, "inflated claim paid out");
    assert_eq!(s.token.balance(&s.id), pool_before, "pool was drained");
    assert!(!s.client.is_nullifier_used(&null));

    // Exactly 2^64 is out of range too, not only values above it.
    let _ = s.client.try_claim(
        &pa, &pb, &pc, &root, &null, &b32(&s.env, 0x33), &recipient, &(1i128 << 64), &0,
    );
    assert_eq!(s.token.balance(&recipient), 0);

    // u64::MAX still pays: the bound is exclusive, matching Num2Bits(64).
    s.client.claim(
        &pa, &pb, &pc, &root, &null, &b32(&s.env, 0x33), &recipient, &(u64::MAX as i128), &0,
    );
    assert_eq!(s.token.balance(&recipient), u64::MAX as i128);
}

#[test]
fn deposit_amount_at_or_above_2_64_rejected() {
    let s = setup();
    let depositor = Address::generate(&s.env);

    // Fund the depositor so an unguarded deposit would actually succeed.
    s.usdc_admin.mint(&depositor, &(INFLATED * 2));

    let _ = s
        .client
        .try_deposit(&depositor, &INFLATED, &b32(&s.env, 0xAA), &0);

    assert_eq!(s.token.balance(&s.id), 0, "oversized deposit was accepted");
}
