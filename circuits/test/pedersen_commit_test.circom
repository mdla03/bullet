// Test harness for PedersenCommit. Not part of the product circuits.
// Witness generation throws for amount >= 2^64 or blinding >= 2^251: that's
// the intended test behavior, not a bug.
pragma circom 2.0.0;

include "../src/jubjub/pedersen_commit.circom";

component main = PedersenCommit();
