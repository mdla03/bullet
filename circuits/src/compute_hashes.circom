pragma circom 2.0.0;

// Helper circuit for gen-test-proof.mjs: computes nullifier, commitment, and the
// Merkle root for a depth-20 tree with one leaf at index 0.
// Contains NO equality constraints (no ===) so the witness calculator never
// throws — all signals are computed and stored, then read back by the script.
//
// Not part of the ZeekPay proof system. Test-only helper.

include "../node_modules/circomlib/circuits/poseidon.circom";

template ComputeHashes() {
    signal input secret;
    signal input recipientDigest;
    signal input amount;
    signal input tokenId;
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

    // zero[i] = Poseidon([zero[i-1], zero[i-1]]) — empty subtree hashes
    component zeros[20];
    signal zeroHashes[21];
    zeroHashes[0] <== 0;
    for (var i = 0; i < 20; i++) {
        zeros[i] = Poseidon(2);
        zeros[i].inputs[0] <== zeroHashes[i];
        zeros[i].inputs[1] <== zeroHashes[i];
        zeroHashes[i + 1] <== zeros[i].out;
    }

    // Merkle path for leaf at index 0 (pathIndices all 0 = always left child)
    component path[20];
    signal pathHashes[21];
    pathHashes[0] <== c.out;
    for (var i = 0; i < 20; i++) {
        path[i] = Poseidon(2);
        path[i].inputs[0] <== pathHashes[i];  // current = left
        path[i].inputs[1] <== zeroHashes[i];  // sibling = empty subtree
        pathHashes[i + 1] <== path[i].out;
    }

    root <== pathHashes[20];
}

component main = ComputeHashes();
