// Test harness for EscalarMulFix over 64 bits, base = Jubjub's generator G
// (circuits/scripts/jubjub-ref.mjs). Not part of the product circuits.
pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../src/jubjub/escalarmulfix.circom";

template JubjubMulFixTest() {
    signal input scalar;
    signal output out[2];

    var BASE[2] = [
        8076246640662884909881801758704306714034609987455869804520522091855516602923,
        13262374693698910701929044844600465831413122818447359594527400194675274060458
    ];

    component n2b = Num2Bits(64);
    n2b.in <== scalar;

    component mulFix = EscalarMulFix(64, BASE);
    var i;
    for (i = 0; i < 64; i++) {
        mulFix.e[i] <== n2b.out[i];
    }

    out[0] <== mulFix.out[0];
    out[1] <== mulFix.out[1];
}

component main = JubjubMulFixTest();
