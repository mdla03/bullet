// Pedersen amount commitment on Jubjub.
//
// Computes C = amount*G + blinding*H, a point on the Jubjub twisted Edwards
// curve (embedded in the BLS12-381 scalar field). Outputs are the affine
// coordinates cx, cy. Only valid when compiled with `circom -p bls12381`.
//
// Hiding relies on `blinding` being uniform prover-chosen randomness; binding
// relies on the discrete log of H with respect to G being unknown. The
// commitment is additively homomorphic: C(a1,r1) + C(a2,r2) = C(a1+a2, r1+r2).
//
// Generators (decimal constants below are copied verbatim from the output of
// `node circuits/scripts/jubjub-ref.mjs`, which is the off-circuit reference
// these values are tested against):
//   G = the Jubjub base point from the Zcash protocol spec, as shipped by
//       @noble/curves/jubjub (jubjub.CURVE.Gx / Gy).
//   H = Zcash's own group hash `findGroupHash("Zcash_cv", "r")`, i.e. Sapling's
//       value-commitment randomness base, reused here as an independent
//       generator with no known discrete-log relation to G.
//
// Bit widths:
//   amount   -> 64 bits. Matches AMOUNT_BITS in claim.circom and the u64
//               truncation in the Soroban contract's derive_public_inputs.
//   blinding -> 251 bits. The Jubjub prime-order subgroup is about 2^252.4
//               (subgroupOrder in jubjub-ref.mjs, a 252-bit value), so 251
//               bits is the largest power-of-two bound that keeps every
//               representable scalar strictly below the subgroup order. That
//               makes the bit decomposition injective on the scalar: no two
//               distinct 251-bit blindings can reduce to the same group
//               element by wrapping the order. `randomBlinding()` in
//               jubjub-ref.mjs samples in the same range so the circuit and
//               the reference agree exactly.
pragma circom 2.0.0;

include "../../node_modules/circomlib/circuits/bitify.circom";
include "escalarmulfix.circom";
include "jubjub.circom";

template PedersenCommit() {
    signal input amount;
    signal input blinding;
    signal output cx;
    signal output cy;

    var G[2] = [
        8076246640662884909881801758704306714034609987455869804520522091855516602923,
        13262374693698910701929044844600465831413122818447359594527400194675274060458
    ];
    var H[2] = [
        47042227020334719030310671629496501061777616454137182971856918820250544653111,
        49531484613049745751551498609154147537293487462303198979615882148044956461707
    ];

    // amount*G (also range-proves 0 <= amount < 2^64)
    component amountBits = Num2Bits(64);
    amountBits.in <== amount;
    component amountMul = EscalarMulFix(64, G);
    for (var i = 0; i < 64; i++) {
        amountMul.e[i] <== amountBits.out[i];
    }

    // blinding*H (also range-proves 0 <= blinding < 2^251)
    component blindingBits = Num2Bits(251);
    blindingBits.in <== blinding;
    component blindingMul = EscalarMulFix(251, H);
    for (var i = 0; i < 251; i++) {
        blindingMul.e[i] <== blindingBits.out[i];
    }

    component sum = JubjubAdd();
    sum.x1 <== amountMul.out[0];
    sum.y1 <== amountMul.out[1];
    sum.x2 <== blindingMul.out[0];
    sum.y2 <== blindingMul.out[1];

    cx <== sum.xout;
    cy <== sum.yout;
}
