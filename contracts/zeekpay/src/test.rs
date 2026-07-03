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
// stateful logic (nullifier replay, root checks, denom, auth, payout). The
// bypass is excluded from the wasm build and cannot ship.
// ----------------------------------------------------------------------------

use crate::{test_support, Denom, Error, ZeekPay, ZeekPayClient};
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
    s.client.deposit(&depositor, &Denom::Ten, &commitment);
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
        .claim(&pa, &pb, &pc, &root, &nullifier, &recipient, &Denom::Ten);

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
    s.client.deposit(&depositor, &Denom::Ten, &b32(&s.env, 0xA1));
    s.client.deposit(&depositor, &Denom::Ten, &b32(&s.env, 0xA2));

    let root = b32(&s.env, 0x11);
    let nullifier = b32(&s.env, 0x22);
    s.client.post_root(&root);
    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);

    s.client
        .claim(&pa, &pb, &pc, &root, &nullifier, &recipient, &Denom::Ten);
    // same nullifier again -> NullifierUsed
    let err = s
        .client
        .try_claim(&pa, &pb, &pc, &root, &nullifier, &recipient, &Denom::Ten)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::NullifierUsed);
    // recipient was paid exactly once.
    assert_eq!(s.token.balance(&recipient), 100_000_000);
}

#[test]
fn unknown_root_rejected() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);
    let err = s
        .client
        .try_claim(
            &pa,
            &pb,
            &pc,
            &b32(&s.env, 0x99),
            &b32(&s.env, 0x22),
            &recipient,
            &Denom::Ten,
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
        .try_deposit(&depositor, &Denom::Ten, &b32(&s.env, 0xAA))
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
            &recipient,
            &Denom::Ten,
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
    s.client.deposit(&depositor, &Denom::Ten, &b32(&s.env, 0xAA));

    let root = b32(&s.env, 0x11);
    let nullifier = b32(&s.env, 0x22);
    s.client.post_root(&root);
    let pa = BytesN::from_array(&s.env, &[0u8; 96]);
    let pb = BytesN::from_array(&s.env, &[0u8; 192]);
    let pc = BytesN::from_array(&s.env, &[0u8; 96]);
    s.client
        .claim(&pa, &pb, &pc, &root, &nullifier, &recipient, &Denom::Ten);

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
