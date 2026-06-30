#!/usr/bin/env bash
# verifier-benchmark: compile circuit, run own Groth16 setup over BLS12-381,
# generate a real proof + verification key. Everything stays local — no chain,
# no network beyond package install, no fees.
#
# Toxic-waste note: the *.ptau contributions produced here carry private
# setup randomness and are gitignored (see .gitignore). Only the public
# verification_key.json / proof are reused downstream.
set -euo pipefail

CIRCOM="${CIRCOM:-$HOME/.local/bin/circom}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # circuits/
SRC="$HERE/src/preimage.circom"
BUILD="$HERE/build"
# Call the binary directly (NOT `pnpm exec`, which would reset cwd away from build/).
SNARKJS="$HERE/node_modules/.bin/snarkjs"

mkdir -p "$BUILD"
cd "$BUILD"

echo "== [1/7] compile circuit (BLS12-381) =="
"$CIRCOM" "$SRC" --r1cs --wasm --sym -p bls12381 -o "$BUILD"

echo "== [2/7] circuit info =="
$SNARKJS r1cs info preimage.r1cs

echo "== [3/7] powers of tau (bls12-381, power 12) =="
$SNARKJS powersoftau new bls12-381 12 pot12_0000.ptau -v
echo "== [4/7] contribute (entropy = throwaway, file gitignored) =="
$SNARKJS powersoftau contribute pot12_0000.ptau pot12_0001.ptau \
  --name="zeekpay-bench" -v -e="$(date +%s%N)benchentropy"
echo "== [5/7] prepare phase2 -> final.ptau =="
$SNARKJS powersoftau prepare phase2 pot12_0001.ptau final.ptau -v

echo "== [6/7] groth16 setup + export verification key =="
$SNARKJS groth16 setup preimage.r1cs final.ptau preimage_0000.zkey
$SNARKJS zkey contribute preimage_0000.zkey preimage.zkey \
  --name="zeekpay-bench-zkey" -v -e="$(date +%s%N)zkeyentropy"
$SNARKJS zkey export verificationkey preimage.zkey verification_key.json

echo "== [7/7] witness + proof =="
# secret = 42 (arbitrary). Generate witness via the compiled wasm.
echo '{ "secret": "42" }' > input.json
# Use snarkjs wtns calculate (avoids circom's CommonJS generate_witness.js,
# which breaks under this package's "type": "module").
$SNARKJS wtns calculate preimage_js/preimage.wasm input.json witness.wtns
$SNARKJS groth16 prove preimage.zkey witness.wtns proof.json public.json
echo "== verify off-chain (sanity) =="
$SNARKJS groth16 verify verification_key.json public.json proof.json

echo "== DONE. Artifacts in $BUILD =="
ls -la verification_key.json proof.json public.json preimage.zkey
