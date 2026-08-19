pragma circom 2.0.0;

// Helper circuit for gen-joinsplit-vectors.mjs. Computes note commitments,
// nullifiers, empty-subtree hashes, and the Merkle root for a depth-20 tree
// holding the two input notes at indices 0 and 1.
//
// Exists because circomlibjs computes Poseidon over BN254 while the real
// circuits compile under -p bls12381. Hashes computed in JS would not match,
// so they are computed here, in-field, and read back out of the witness.
//
// Contains NO equality constraints (no ===) so the witness calculator never
// throws. Test-only helper, not part of the proof system.

include "../node_modules/circomlib/circuits/poseidon.circom";

template JoinSplitHashes(DEPTH, N_IN, N_OUT) {
    signal input secret[N_IN];
    signal input recipientDigest[N_IN];
    signal input value[N_IN];
    signal input leafIndex[N_IN];
    signal input secretOut[N_OUT];
    signal input recipientDigestOut[N_OUT];
    signal input valueOut[N_OUT];
    signal input tokenId;

    signal output inCommitment[N_IN];
    signal output nullifier[N_IN];
    signal output outCommitment[N_OUT];
    signal output zeroHash[DEPTH];  // empty subtree root at each level
    signal output root;

    // ── input notes: commitment and nullifier ───────────────────────────────
    component c[N_IN];
    component n[N_IN];
    for (var i = 0; i < N_IN; i++) {
        c[i] = Poseidon(4);
        c[i].inputs[0] <== secret[i];
        c[i].inputs[1] <== recipientDigest[i];
        c[i].inputs[2] <== value[i];
        c[i].inputs[3] <== tokenId;
        inCommitment[i] <== c[i].out;

        n[i] = Poseidon(2);
        n[i].inputs[0] <== secret[i];
        n[i].inputs[1] <== leafIndex[i];
        nullifier[i] <== n[i].out;
    }

    // ── output notes: commitment only ───────────────────────────────────────
    component co[N_OUT];
    for (var j = 0; j < N_OUT; j++) {
        co[j] = Poseidon(4);
        co[j].inputs[0] <== secretOut[j];
        co[j].inputs[1] <== recipientDigestOut[j];
        co[j].inputs[2] <== valueOut[j];
        co[j].inputs[3] <== tokenId;
        outCommitment[j] <== co[j].out;
    }

    // ── empty subtree hashes: zh[0] = 0, zh[k] = Poseidon(zh[k-1], zh[k-1]) ──
    component z[DEPTH];
    signal zh[DEPTH + 1];
    zh[0] <== 0;
    for (var k = 0; k < DEPTH; k++) {
        z[k] = Poseidon(2);
        z[k].inputs[0] <== zh[k];
        z[k].inputs[1] <== zh[k];
        zh[k + 1] <== z[k].out;
        zeroHash[k] <== zh[k];
    }

    // ── root of a tree with the two input notes at indices 0 and 1 ──────────
    // Level 1 combines the two leaves; every level above pairs with the empty
    // subtree on the right, since nothing else is in the tree.
    signal node[DEPTH + 1];
    component lvl1 = Poseidon(2);
    lvl1.inputs[0] <== inCommitment[0];
    lvl1.inputs[1] <== inCommitment[1];
    node[1] <== lvl1.out;

    component up[DEPTH];
    for (var k = 1; k < DEPTH; k++) {
        up[k] = Poseidon(2);
        up[k].inputs[0] <== node[k];
        up[k].inputs[1] <== zh[k];
        node[k + 1] <== up[k].out;
    }

    root <== node[DEPTH];
}

component main = JoinSplitHashes(20, 2, 2);
