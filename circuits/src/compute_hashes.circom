pragma circom 2.0.0;

// Helper circuit for gen-test-proof.mjs: computes nullifier, commitment, and the
// Merkle root for a depth-20 tree along a caller-supplied path (pathElements /
// pathIndices), mirroring claim.circom's Merkle-selector logic exactly so the
// root this produces is self-consistent with what claim.circom accepts for
// the same path.
// Contains NO equality constraints (no ===) so the witness calculator never
// throws. All signals are computed and stored, then read back by the script.
//
// The amount commitment is deliberately NOT computed here. It is a Pedersen
// commitment on Jubjub (see src/jubjub/pedersen_commit.circom), and this helper
// has no equality constraints by design, so there is nothing for it to add over
// the off-circuit `commit()` in scripts/jubjub-ref.mjs, which the 21 tests in
// test/jubjub.test.mjs pin against the in-circuit gadget. It also must not
// carry the old Poseidon([amount, blinding]) commitment: claim.circom has not
// used that shape since the Pedersen swap.
//
// Not part of the ZeekPay proof system. Test-only helper.

include "../node_modules/circomlib/circuits/poseidon.circom";

template ComputeHashes() {
    signal input secret;
    signal input recipientDigest;
    signal input amount;
    signal input tokenId;
    signal input pathElements[20];
    signal input pathIndices[20];  // 0 = current node is left, 1 = right
    signal output nullifier;
    signal output root;

    // nullifier = Poseidon([secret])
    component n = Poseidon(1);
    n.inputs[0] <== secret;
    nullifier <== n.out;

    // commitment = Poseidon([secret, recipientDigest, amount, tokenId])
    component c = Poseidon(4);
    c.inputs[0] <== secret;
    c.inputs[1] <== recipientDigest;
    c.inputs[2] <== amount;
    c.inputs[3] <== tokenId;

    // Merkle path, same left/right selector as claim.circom.
    component path[20];
    signal levelHashes[21];
    signal left[20];
    signal right[20];
    levelHashes[0] <== c.out;
    for (var i = 0; i < 20; i++) {
        left[i]  <== (pathElements[i] - levelHashes[i]) * pathIndices[i] + levelHashes[i];
        right[i] <== (levelHashes[i] - pathElements[i]) * pathIndices[i] + pathElements[i];

        path[i] = Poseidon(2);
        path[i].inputs[0] <== left[i];
        path[i].inputs[1] <== right[i];
        levelHashes[i + 1] <== path[i].out;
    }

    root <== levelHashes[20];
}

component main = ComputeHashes();
