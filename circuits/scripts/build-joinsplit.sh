#!/usr/bin/env bash
# Build the shielded-pool join-split circuit end-to-end:
#   compile → pot15 ceremony (if missing) → Groth16 setup → export vk → prove → verify
#
# Mirrors build-claim.sh. Everything is local: no network, no fees.
#
# Outputs (tracked, safe to commit):
#   circuits/build/joinsplit_vk.json
#   circuits/build/joinsplit_proof.json
#   circuits/build/joinsplit_public.json
#
# Outputs (gitignored — do NOT commit):
#   circuits/build/joinsplit.r1cs  *.sym  *.zkey  *.wtns  pot15*.ptau
#   circuits/build/joinsplit_js/
#
# Toxic waste: the intermediate pot15 contributions carry private setup
# randomness. They are deleted below and gitignored. Leaking them compromises
# soundness of every proof made under this key.
set -euo pipefail

CIRCOM="${CIRCOM:-$HOME/.local/bin/circom}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # circuits/
BUILD="$HERE/build"
SNARKJS="$HERE/node_modules/.bin/snarkjs"

# Phase-2 setup on a ~25k-constraint circuit exceeds the default heap.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

mkdir -p "$BUILD"

echo "== [1/5] compile joinsplit.circom (BLS12-381) =="
"$CIRCOM" "$HERE/src/joinsplit.circom" --r1cs --wasm --sym -p bls12381 -o "$BUILD"
"$SNARKJS" r1cs info "$BUILD/joinsplit.r1cs"

echo "== [2/5] powers of tau (bls12-381, power 15) =="
# join-split: 25,177 constraints → needs 2^15 = 32768. pot14 (16384) is short.
if [ ! -f "$BUILD/pot15_final.ptau" ]; then
    "$SNARKJS" powersoftau new bls12-381 15 "$BUILD/pot15_0.ptau" -v
    "$SNARKJS" powersoftau contribute "$BUILD/pot15_0.ptau" "$BUILD/pot15_1.ptau" \
        --name="bullet-joinsplit" -v -e="$(date +%s%N)joinsplitentropy"
    "$SNARKJS" powersoftau prepare phase2 "$BUILD/pot15_1.ptau" \
        "$BUILD/pot15_final.ptau" -v
    rm -f "$BUILD/pot15_0.ptau" "$BUILD/pot15_1.ptau"
    echo "pot15_final.ptau generated."
else
    echo "pot15_final.ptau already exists, skipping ceremony."
fi

echo "== [3/5] Groth16 setup =="
# Same rule as build-claim.sh: regenerating draws fresh entropy, which means a
# new vk, which means every proof from the old key stops verifying. Reuse an
# existing key unless FORCE_SETUP=1.
if [ -f "$BUILD/joinsplit.zkey" ] && [ "${FORCE_SETUP:-0}" != "1" ]; then
    echo "joinsplit.zkey exists, reusing."
    echo "  To rotate: FORCE_SETUP=1 ./scripts/build-joinsplit.sh, then re-run"
    echo "  set_vk on the deployed pool contract with the new vk."
else
    "$SNARKJS" groth16 setup "$BUILD/joinsplit.r1cs" "$BUILD/pot15_final.ptau" \
        "$BUILD/joinsplit_0.zkey"
    "$SNARKJS" zkey contribute "$BUILD/joinsplit_0.zkey" "$BUILD/joinsplit.zkey" \
        --name="bullet-joinsplit" -v -e="$(date +%s%N)joinsplitzkeyentropy"
    rm -f "$BUILD/joinsplit_0.zkey"
fi

echo "== [4/5] export verification key =="
"$SNARKJS" zkey export verificationkey "$BUILD/joinsplit.zkey" "$BUILD/joinsplit_vk.json"

echo "== [5/5] prove and verify the fixture vector =="
# The fixture vector, not "valid": its public legs are distinct and non-zero
# (deposit 7, withdraw 3, tokenId 0), so a contract that pushes them in the
# wrong order fails verification. An all-zero vector cannot detect that.
if [ ! -f "$BUILD/joinsplit_input_fixture.json" ]; then
    echo "no valid vector, generating..."
    node "$HERE/scripts/gen-joinsplit-vectors.mjs"
fi
"$SNARKJS" groth16 fullprove \
    "$BUILD/joinsplit_input_fixture.json" \
    "$BUILD/joinsplit_js/joinsplit.wasm" \
    "$BUILD/joinsplit.zkey" \
    "$BUILD/joinsplit_proof.json" \
    "$BUILD/joinsplit_public.json"
"$SNARKJS" groth16 verify \
    "$BUILD/joinsplit_vk.json" \
    "$BUILD/joinsplit_public.json" \
    "$BUILD/joinsplit_proof.json"

echo ""
echo "== DONE =="
ls -la "$BUILD/joinsplit_vk.json" "$BUILD/joinsplit_proof.json" "$BUILD/joinsplit_public.json"
ls -lh "$BUILD/joinsplit.zkey" "$BUILD/joinsplit_js/joinsplit.wasm"
