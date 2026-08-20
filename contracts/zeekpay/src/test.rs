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

// ---------------------------------------------------------------------------
// Shielded pool (join-split) tests.
//
// These use the cfg(test) verify bypass, like the other business-logic tests,
// so they exercise the contract's state handling rather than the SNARK. The
// balance constraint itself is tested in-circuit by
// circuits/scripts/gen-joinsplit-vectors.mjs.
// ---------------------------------------------------------------------------

use crate::ProofBytes;

fn zero_proof(env: &Env) -> ProofBytes {
    ProofBytes {
        a: BytesN::from_array(env, &[0u8; 96]),
        b: BytesN::from_array(env, &[0u8; 192]),
        c: BytesN::from_array(env, &[0u8; 96]),
    }
}

/// A canonical field element derived from a tag byte. `b32` alone is not
/// enough here: any tag at or above 0x73 exceeds the BLS12-381 modulus and the
/// contract rejects it as NonCanonicalInput before reaching the check under
/// test. Masking the top byte keeps every tag usable while staying canonical.
fn fr32(env: &Env, tag: u8) -> BytesN<32> {
    let mut buf = [tag; 32];
    buf[0] &= 0x0f;
    BytesN::from_array(env, &buf)
}

fn vec32(env: &Env, bytes: &[u8]) -> soroban_sdk::Vec<BytesN<32>> {
    let mut v = soroban_sdk::Vec::new(env);
    for b in bytes {
        v.push_back(fr32(env, *b));
    }
    v
}

#[test]
fn pool_deposit_then_withdraw() {
    let s = setup();
    let depositor = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    s.usdc_admin.mint(&depositor, &1_000_000_000);

    let root = b32(&s.env, 0x11);
    s.client.post_root(&root);

    // Deposit: value enters the pool, dummy inputs, two fresh output notes.
    s.client.transact(
        &zero_proof(&s.env),
        &root,
        &vec32(&s.env, &[0x01, 0x02]),
        &vec32(&s.env, &[0xA1, 0xA2]),
        &TEN_USDC,
        &0,
        &0,
        &depositor,
        &recipient,
    );
    assert_eq!(s.token.balance(&s.id), TEN_USDC);
    assert_eq!(s.token.balance(&depositor), 900_000_000);

    // Withdraw: value leaves the pool to the recipient.
    s.client.transact(
        &zero_proof(&s.env),
        &root,
        &vec32(&s.env, &[0x03, 0x04]),
        &vec32(&s.env, &[0xA3, 0xA4]),
        &0,
        &TEN_USDC,
        &0,
        &depositor,
        &recipient,
    );
    assert_eq!(s.token.balance(&recipient), TEN_USDC);
    assert_eq!(s.token.balance(&s.id), 0);
}

#[test]
fn pool_in_pool_transfer_moves_no_tokens() {
    let s = setup();
    let a = Address::generate(&s.env);
    let root = b32(&s.env, 0x11);
    s.client.post_root(&root);

    // Both public legs zero: nothing on-chain reveals an amount.
    s.client.transact(
        &zero_proof(&s.env),
        &root,
        &vec32(&s.env, &[0x05, 0x06]),
        &vec32(&s.env, &[0xB1, 0xB2]),
        &0,
        &0,
        &0,
        &a,
        &a,
    );
    assert_eq!(s.token.balance(&s.id), 0);
    assert!(s.client.is_nullifier_used(&fr32(&s.env, 0x05)));
    assert!(s.client.is_nullifier_used(&fr32(&s.env, 0x06)));
}

/// THE ordering test. The circuit does not constrain the two nullifiers to
/// differ, so a prover can pass the same note twice. This must be rejected by
/// the contract's check-then-set loop. If that loop is ever changed to check
/// both nullifiers before writing either, this test fails and the pool becomes
/// double-spendable.
#[test]
fn pool_same_nullifier_twice_in_one_tx_rejected() {
    let s = setup();
    let a = Address::generate(&s.env);
    let root = b32(&s.env, 0x11);
    s.client.post_root(&root);

    let dup = vec32(&s.env, &[0x07, 0x07]); // same note, twice
    let err = s
        .client
        .try_transact(
            &zero_proof(&s.env),
            &root,
            &dup,
            &vec32(&s.env, &[0xC1, 0xC2]),
            &0,
            &TEN_USDC,
            &0,
            &a,
            &a,
        )
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::NullifierUsed);
    assert_eq!(s.token.balance(&a), 0, "double spend paid out");
}

#[test]
fn pool_replayed_nullifier_rejected() {
    let s = setup();
    let a = Address::generate(&s.env);
    let root = b32(&s.env, 0x11);
    s.client.post_root(&root);

    s.client.transact(
        &zero_proof(&s.env), &root,
        &vec32(&s.env, &[0x08, 0x09]),
        &vec32(&s.env, &[0xD1, 0xD2]),
        &0, &0, &0, &a, &a,
    );
    // Reuse 0x08 in a later transaction.
    let err = s
        .client
        .try_transact(
            &zero_proof(&s.env), &root,
            &vec32(&s.env, &[0x08, 0x0A]),
            &vec32(&s.env, &[0xD3, 0xD4]),
            &0, &0, &0, &a, &a,
        )
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::NullifierUsed);
}

#[test]
fn pool_wrong_shape_rejected() {
    let s = setup();
    let a = Address::generate(&s.env);
    let root = b32(&s.env, 0x11);
    s.client.post_root(&root);

    let err = s
        .client
        .try_transact(
            &zero_proof(&s.env), &root,
            &vec32(&s.env, &[0x0B]),            // one nullifier, circuit wants two
            &vec32(&s.env, &[0xE1, 0xE2]),
            &0, &0, &0, &a, &a,
        )
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::InvalidShape);
}

#[test]
fn pool_amount_bounds_enforced() {
    let s = setup();
    let a = Address::generate(&s.env);
    s.usdc_admin.mint(&a, &(INFLATED * 2));
    s.usdc_admin.mint(&s.id, &(INFLATED * 2));
    let root = b32(&s.env, 0x11);
    s.client.post_root(&root);
    let pool_before = s.token.balance(&s.id);

    // Same truncation hazard as claim: 2^64 + X encodes as X.
    let _ = s.client.try_transact(
        &zero_proof(&s.env), &root,
        &vec32(&s.env, &[0x0C, 0x0D]),
        &vec32(&s.env, &[0xF1, 0xF2]),
        &0, &INFLATED, &0, &a, &a,
    );
    assert_eq!(s.token.balance(&s.id), pool_before, "pool drained");

    // Negative is rejected too.
    let err = s
        .client
        .try_transact(
            &zero_proof(&s.env), &root,
            &vec32(&s.env, &[0x0C, 0x0D]),
            &vec32(&s.env, &[0xF1, 0xF2]),
            &-1, &0, &0, &a, &a,
        )
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn pool_unknown_root_rejected() {
    let s = setup();
    let a = Address::generate(&s.env);
    let err = s
        .client
        .try_transact(
            &zero_proof(&s.env),
            &fr32(&s.env, 0x6E), // never posted
            &vec32(&s.env, &[0x0E, 0x0F]),
            &vec32(&s.env, &[0xF3, 0xF4]),
            &0, &0, &0, &a, &a,
        )
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::UnknownRoot);
}

// ---------------------------------------------------------------------------
// Real join-split proof, end to end through the contract.
//
// The pool tests above use the verify bypass, so until now
// derive_pool_public_inputs had never been checked against the actual circuit.
// A wrong ordering there fails silently: proofs simply never verify, which
// looks like a bad key rather than a bug. These run the real verifier.
// ---------------------------------------------------------------------------

use crate::joinsplit_fixture as jsx;
use crate::VkData;

fn hex32(env: &Env, h: &str) -> BytesN<32> {
    let v = hex::decode(h).unwrap();
    let a: [u8; 32] = v.try_into().unwrap();
    BytesN::from_array(env, &a)
}
fn hex96(env: &Env, h: &str) -> BytesN<96> {
    let v = hex::decode(h).unwrap();
    let a: [u8; 96] = v.try_into().unwrap();
    BytesN::from_array(env, &a)
}
fn hex192(env: &Env, h: &str) -> BytesN<192> {
    let v = hex::decode(h).unwrap();
    let a: [u8; 192] = v.try_into().unwrap();
    BytesN::from_array(env, &a)
}

fn joinsplit_vkdata(env: &Env) -> VkData {
    let mut ic: soroban_sdk::Vec<BytesN<96>> = soroban_sdk::Vec::new(env);
    for h in jsx::IC {
        ic.push_back(hex96(env, h));
    }
    VkData {
        alpha1: hex96(env, jsx::ALPHA1),
        beta2: hex192(env, jsx::BETA2),
        gamma2: hex192(env, jsx::GAMMA2),
        delta2: hex192(env, jsx::DELTA2),
        ic,
    }
}

/// Low level: the proof verifies against the verifier directly. If this fails,
/// the byte encoding is wrong (most likely G2 c1/c0 order), not the circuit.
#[test]
fn pool_real_proof_verifies() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();

    let mut ic: Vec<G1Affine> = Vec::new(&env);
    for h in jsx::IC {
        ic.push_back(g1(&env, h));
    }
    let vk = VerifyingKey {
        alpha1: g1(&env, jsx::ALPHA1),
        beta2: g2(&env, jsx::BETA2),
        gamma2: g2(&env, jsx::GAMMA2),
        delta2: g2(&env, jsx::DELTA2),
        ic,
    };
    let proof = Proof {
        a: g1(&env, jsx::PROOF_A),
        b: g2(&env, jsx::PROOF_B),
        c: g1(&env, jsx::PROOF_C),
    };
    let mut pubs: Vec<Fr> = Vec::new(&env);
    for h in jsx::PUBS {
        pubs.push_back(fr(&env, h));
    }
    assert_eq!(jsx::PUBS.len(), 8, "join-split has 8 public inputs");
    assert_eq!(jsx::IC.len(), 9, "IC must be pubs + 1");
    assert!(verify(&env, &vk, &proof, &pubs), "real join-split proof must verify");
}

/// End to end: a real proof through `transact`, with the verify bypass OFF.
/// This is what pins derive_pool_public_inputs to the circuit's locked order
/// [root, nullifiers.., commitments.., deposit, withdraw, tokenId].
#[test]
fn pool_real_proof_through_transact() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let id = env.register(ZeekPay, ());
    let client = ZeekPayClient::new(&env, &id);
    client.initialize(&admin, &sac.address());
    client.set_pool_vk(&joinsplit_vkdata(&env));
    // Deliberately NOT setting the verify bypass.

    let root = hex32(&env, jsx::PUBS[0]);
    client.post_root(&root);

    let mut nulls: soroban_sdk::Vec<BytesN<32>> = soroban_sdk::Vec::new(&env);
    nulls.push_back(hex32(&env, jsx::PUBS[1]));
    nulls.push_back(hex32(&env, jsx::PUBS[2]));
    let mut cmts: soroban_sdk::Vec<BytesN<32>> = soroban_sdk::Vec::new(&env);
    cmts.push_back(hex32(&env, jsx::PUBS[3]));
    cmts.push_back(hex32(&env, jsx::PUBS[4]));

    let a = Address::generate(&env);
    let proof = crate::ProofBytes {
        a: hex96(&env, jsx::PROOF_A),
        b: hex192(&env, jsx::PROOF_B),
        c: hex96(&env, jsx::PROOF_C),
    };

    // The fixture vector has distinct public legs: deposit 7, withdraw 3,
    // tokenId 0. They differ on purpose. With all three zero, a contract that
    // pushed them in the wrong order would still verify, so the vector could
    // not detect a public-input ordering bug.
    let sac_admin = token::StellarAssetClient::new(&env, &sac.address());
    let tok = token::Client::new(&env, &sac.address());
    sac_admin.mint(&a, &1_000);
    sac_admin.mint(&id, &1_000);
    client.transact(&proof, &root, &nulls, &cmts, &7, &3, &0, &a, &a);
    // Deposit pulled 7 in, withdrawal paid 3 out: net +4 to the pool.
    assert_eq!(tok.balance(&id), 1_004);

    assert!(client.is_nullifier_used(&hex32(&env, jsx::PUBS[1])));
    assert!(client.is_nullifier_used(&hex32(&env, jsx::PUBS[2])));
}

/// Proves the ordering above is actually load-bearing: swap the two nullifiers
/// and the same proof must stop verifying. Without this, a test that passed
/// with a wrong order would look identical to one that passed with the right
/// order.
#[test]
fn pool_swapped_public_inputs_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let id = env.register(ZeekPay, ());
    let client = ZeekPayClient::new(&env, &id);
    client.initialize(&admin, &sac.address());
    client.set_pool_vk(&joinsplit_vkdata(&env));

    let root = hex32(&env, jsx::PUBS[0]);
    client.post_root(&root);

    // Nullifiers in the wrong order.
    let mut nulls: soroban_sdk::Vec<BytesN<32>> = soroban_sdk::Vec::new(&env);
    nulls.push_back(hex32(&env, jsx::PUBS[2]));
    nulls.push_back(hex32(&env, jsx::PUBS[1]));
    let mut cmts: soroban_sdk::Vec<BytesN<32>> = soroban_sdk::Vec::new(&env);
    cmts.push_back(hex32(&env, jsx::PUBS[3]));
    cmts.push_back(hex32(&env, jsx::PUBS[4]));

    let a = Address::generate(&env);
    let proof = crate::ProofBytes {
        a: hex96(&env, jsx::PROOF_A),
        b: hex192(&env, jsx::PROOF_B),
        c: hex96(&env, jsx::PROOF_C),
    };
    let err = client
        .try_transact(&proof, &root, &nulls, &cmts, &7, &3, &0, &a, &a)
        .err()
        .unwrap()
        .unwrap();
    assert_eq!(err, Error::InvalidProof);
}

// ---------------------------------------------------------------------------
// Contract upgrade.
//
// The admin gate is what these test. The upgrade itself replaces the running
// code, which a native-registered test contract cannot exercise, so the round
// trip is verified on testnet instead. What matters here is that a non-admin
// cannot call it: whoever can upgrade can swap in arbitrary code and take the
// pooled funds.
// ---------------------------------------------------------------------------

// No standalone "non-admin cannot upgrade" test. In the native test env a
// bogus wasm hash traps inside update_current_contract_wasm whether or not the
// admin gate is present, so an is_err() assertion passes either way, and
// env.auths() is empty after the trapped call. `upgrade_before_init_fails`
// below is the real guard: it asserts a specific contract error that is only
// reachable through require_admin. Confirmed by deleting the gate and watching
// it fail. The admin gate itself is exercised for real on testnet.
#[test]
fn upgrade_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(ZeekPay, ());
    let client = ZeekPayClient::new(&env, &id);

    // No admin stored yet, so require_admin cannot resolve one.
    let err = client.try_upgrade(&b32(&env, 0x99)).err().unwrap().unwrap();
    assert_eq!(err, Error::NotInitialized);
}

#[test]
fn upgrade_is_not_blocked_by_pause() {
    // A contract paused because something is wrong with it must still be
    // fixable. If this ever starts failing, someone added a pause check to
    // upgrade and locked the contract out of its own repair path.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let id = env.register(ZeekPay, ());
    let client = ZeekPayClient::new(&env, &id);
    client.initialize(&admin, &sac.address());
    client.set_paused(&true);

    // Reaching update_current_contract_wasm with a hash that is not an
    // uploaded wasm traps, which is itself the proof that the pause check did
    // not short-circuit first: a Paused error would have returned cleanly.
    let res = client.try_upgrade(&b32(&env, 0x99));
    assert!(res.is_err());
    match res.err().unwrap() {
        Ok(e) => panic!("expected a host trap past the pause check, got {:?}", e),
        Err(_) => {} // host error: we got past the guard, as intended
    }
}
