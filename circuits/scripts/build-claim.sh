#!/usr/bin/env bash
# Build the ZeekPay claim circuit end-to-end:
#   compile → pot13 ceremony (if missing) → Groth16 setup → export vk → convert for Soroban
#
# Outputs (tracked, safe to commit):
#   circuits/build/claim_vk.json
#   circuits/build/groth16_soroban.json
#   contracts/zeekpay/src/groth16_fixture.rs
#
# Outputs (gitignored — do NOT commit):
#   circuits/build/claim.r1cs   *.sym   *.zkey   *.wtns   pot13*.ptau
#   circuits/build/claim_js/
set -euo pipefail

CIRCOM="${CIRCOM:-$HOME/.local/bin/circom}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # circuits/
BUILD="$HERE/build"
SNARKJS="$HERE/node_modules/.bin/snarkjs"

mkdir -p "$BUILD"

echo "== [1/6] compile claim.circom (BLS12-381) =="
"$CIRCOM" "$HERE/src/claim.circom" --r1cs --wasm --sym -p bls12381 -o "$BUILD"
"$SNARKJS" r1cs info "$BUILD/claim.r1cs"

echo "== [2/6] powers of tau (bls12-381, power 14) =="
# claim circuit: 11420 total constraints → need 2^14 = 16384 ≥ 11420
if [ ! -f "$BUILD/pot14_final.ptau" ]; then
    "$SNARKJS" powersoftau new bls12-381 14 "$BUILD/pot14_0.ptau" -v
    "$SNARKJS" powersoftau contribute "$BUILD/pot14_0.ptau" "$BUILD/pot14_1.ptau" \
        --name="zeekpay-claim" -v -e="$(date +%s%N)claimentropy"
    "$SNARKJS" powersoftau prepare phase2 "$BUILD/pot14_1.ptau" \
        "$BUILD/pot14_final.ptau" -v
    rm -f "$BUILD/pot14_0.ptau" "$BUILD/pot14_1.ptau"
    echo "pot14_final.ptau generated."
else
    echo "pot14_final.ptau already exists, skipping ceremony."
fi

echo "== [3/6] Groth16 setup =="
"$SNARKJS" groth16 setup "$BUILD/claim.r1cs" "$BUILD/pot14_final.ptau" \
    "$BUILD/claim_0.zkey"
"$SNARKJS" zkey contribute "$BUILD/claim_0.zkey" "$BUILD/claim.zkey" \
    --name="zeekpay-claim" -v -e="$(date +%s%N)claimzkeyentropy"
rm -f "$BUILD/claim_0.zkey"

echo "== [4/6] export verification key =="
"$SNARKJS" zkey export verificationkey "$BUILD/claim.zkey" "$BUILD/claim_vk.json"

echo "== [5/6] generate test proof (for fixture + Rust test) =="
node "$HERE/scripts/gen-test-proof.mjs"

echo "== [6/6] convert to Soroban encoding =="
node "$HERE/scripts/convert-to-soroban.mjs"

echo ""
echo "== DONE =="
echo "Tracked artifacts:"
ls -la "$BUILD/claim_vk.json" "$BUILD/claim_proof.json" "$BUILD/claim_public.json"
ls -la "$BUILD/groth16_soroban.json"
ls -la contracts/zeekpay/src/groth16_fixture.rs 2>/dev/null || true
echo ""
echo "WASM (for in-browser proving):"
ls -la "$BUILD/claim_js/claim.wasm"
