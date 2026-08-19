pragma circom 2.0.0;

// Shielded-pool join-split. Design and honest-scope notes live in
// pipeline/shielded-pool/spec.md; read that before changing anything here.
//
// Proves the caller owns N_IN notes in the tree at `root`, spends them, and
// creates N_OUT new notes, such that value is conserved:
//
//     sum(inputs) + publicDeposit == sum(outputs) + publicWithdraw
//
// SECURITY: the balance constraint at the bottom of this file is the whole
// point. A bug there mints value from nothing. The range proofs exist to make
// that equation mean what it looks like: every value is forced under 2^64, so
// the largest reachable sum is (N_IN + N_OUT + 2) * 2^64, far below the
// BLS12-381 scalar field modulus (~2^255), and the sum cannot wrap. If anyone
// widens AMOUNT_BITS or raises N_IN/N_OUT, redo that arithmetic.
//
// What this hides, and what it does not: deposit and withdrawal legs are
// ordinary SAC transfers with visible amounts. Only in-pool value is hidden,
// and unlinkability depends on the anonymity set, not on this circuit. See the
// spec's scope section before writing any user-facing copy.
//
// Poseidon caveat, carried over from claim.circom: circomlib's Poseidon ships
// BN254 round constants and this compiles under -p bls12381. Not a canonical
// instantiation over this field. Accepted for testnet; top of the list for the
// external audit the SOW requires before mainnet.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// Merkle inclusion for one leaf. Returns the root it computes; the caller
// decides whether to enforce it (dummy inputs skip the check).
template MerklePath(DEPTH) {
    signal input leaf;
    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH];
    signal output root;
    // Binary decomposition of the leaf's position, so the caller can bind a
    // nullifier to it. See the note at the call site: this is load-bearing.
    signal output index;

    component hashers[DEPTH];
    signal levelHashes[DEPTH + 1];
    signal left[DEPTH];
    signal right[DEPTH];

    levelHashes[0] <== leaf;

    var idx = 0;
    var e2 = 1;

    for (var i = 0; i < DEPTH; i++) {
        // pathIndices[i] in {0,1}. Without this the conditional swap below is
        // not a swap and any sibling ordering can be forged.
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // 0 = current node is the left child, 1 = current node is the right.
        left[i]  <== (pathElements[i] - levelHashes[i]) * pathIndices[i] + levelHashes[i];
        right[i] <== (levelHashes[i] - pathElements[i]) * pathIndices[i] + pathElements[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        levelHashes[i + 1] <== hashers[i].out;

        idx += pathIndices[i] * e2;
        e2 = e2 + e2;
    }

    root <== levelHashes[DEPTH];
    index <== idx;
}

template JoinSplit(DEPTH, AMOUNT_BITS, N_IN, N_OUT) {
    // ── public inputs (order LOCKED once the contract ships; append only) ────
    signal input root;
    signal input nullifierPub[N_IN];
    signal input commitmentOutPub[N_OUT];
    signal input publicDeposit;   // tokens entering the pool, visible on-chain
    signal input publicWithdraw;  // tokens leaving the pool, visible on-chain
    signal input tokenId;

    // ── private: input notes ────────────────────────────────────────────────
    signal input secret[N_IN];
    signal input recipientDigest[N_IN];
    signal input value[N_IN];
    signal input leafIndex[N_IN];
    signal input pathElements[N_IN][DEPTH];
    signal input pathIndices[N_IN][DEPTH];
    signal input isDummy[N_IN];   // 1 = padding note, contributes nothing

    // ── private: output notes ───────────────────────────────────────────────
    signal input secretOut[N_OUT];
    signal input recipientDigestOut[N_OUT];
    signal input valueOut[N_OUT];

    component inCommitment[N_IN];
    component inPath[N_IN];
    component inNullifier[N_IN];
    component inRange[N_IN];

    for (var i = 0; i < N_IN; i++) {
        // isDummy is boolean, and a dummy is worth nothing. Marking a real note
        // dummy therefore gains nothing: its value is forced to zero and it
        // drops out of the balance equation.
        isDummy[i] * (1 - isDummy[i]) === 0;
        isDummy[i] * value[i] === 0;

        // Every value in the balance equation is range-proofed. Dummies too:
        // their value is already forced to 0, and constraining uniformly keeps
        // the overflow argument above simple.
        inRange[i] = Num2Bits(AMOUNT_BITS);
        inRange[i].in <== value[i];

        // Note commitment. tokenId is the public signal, so all notes in a
        // transaction are bound to one token and cross-token spends fail.
        inCommitment[i] = Poseidon(4);
        inCommitment[i].inputs[0] <== secret[i];
        inCommitment[i].inputs[1] <== recipientDigest[i];
        inCommitment[i].inputs[2] <== value[i];
        inCommitment[i].inputs[3] <== tokenId;

        inPath[i] = MerklePath(DEPTH);
        inPath[i].leaf <== inCommitment[i].out;
        for (var k = 0; k < DEPTH; k++) {
            inPath[i].pathElements[k] <== pathElements[i][k];
            inPath[i].pathIndices[k] <== pathIndices[i][k];
        }

        // Membership binds only for real notes. A dummy has no position in the
        // tree, so requiring it would make deposits into an empty pool
        // unprovable.
        (1 - isDummy[i]) * (inPath[i].root - root) === 0;

        // LOAD-BEARING: leafIndex must be the position the path actually
        // proves. The nullifier is derived from it, so if the two could differ
        // a prover would pick a second index for the same note, derive a second
        // distinct nullifier, and spend that note twice.
        leafIndex[i] === inPath[i].index;

        // Nullifier binds the note's secret to its position. Poseidon([secret])
        // alone, as in claim.circom, collides across notes that share a secret,
        // which makes all but one of them unspendable.
        inNullifier[i] = Poseidon(2);
        inNullifier[i].inputs[0] <== secret[i];
        inNullifier[i].inputs[1] <== leafIndex[i];
        inNullifier[i].out === nullifierPub[i];
    }

    component outCommitment[N_OUT];
    component outRange[N_OUT];

    for (var j = 0; j < N_OUT; j++) {
        outRange[j] = Num2Bits(AMOUNT_BITS);
        outRange[j].in <== valueOut[j];

        outCommitment[j] = Poseidon(4);
        outCommitment[j].inputs[0] <== secretOut[j];
        outCommitment[j].inputs[1] <== recipientDigestOut[j];
        outCommitment[j].inputs[2] <== valueOut[j];
        outCommitment[j].inputs[3] <== tokenId;
        outCommitment[j].out === commitmentOutPub[j];
    }

    // Public legs are range-proofed for the same overflow reason. The contract
    // enforces the matching bound via AMOUNT_MAX_EXCLUSIVE; both halves stay.
    component depositRange = Num2Bits(AMOUNT_BITS);
    depositRange.in <== publicDeposit;
    component withdrawRange = Num2Bits(AMOUNT_BITS);
    withdrawRange.in <== publicWithdraw;

    // ── balance ─────────────────────────────────────────────────────────────
    // The security core. Everything above exists to make this line trustworthy.
    var sumIn = publicDeposit;
    for (var i = 0; i < N_IN; i++) {
        sumIn += value[i];
    }
    var sumOut = publicWithdraw;
    for (var j = 0; j < N_OUT; j++) {
        sumOut += valueOut[j];
    }
    sumIn === sumOut;

    // NOT enforced here, by design: that the two nullifiers differ. A prover
    // can pass the same note twice. The contract rejects a nullifier it has
    // already recorded, including a repeat inside one transaction, which is
    // cheaper there than an inverse gadget here. If the contract ever stops
    // checking that, this circuit becomes unsound.
}

component main {
    public [root, nullifierPub, commitmentOutPub, publicDeposit, publicWithdraw, tokenId]
} = JoinSplit(20, 64, 2, 2);
