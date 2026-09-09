// Test harness for JubjubCheck. Not part of the product circuits.
// Witness generation throws for an off-curve (x,y): that's the intended
// test behavior, not a bug.
pragma circom 2.0.0;

include "../src/jubjub/jubjub.circom";

component main = JubjubCheck();
