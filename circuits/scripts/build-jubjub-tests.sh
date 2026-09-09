#!/usr/bin/env bash
# Compile the Jubjub/Pedersen test harness circuits that
# circuits/test/jubjub.test.mjs generates witnesses against.
#
# Outputs land in circuits/test/build/, which is gitignored: without this step
# a fresh clone has no wasm and every test in jubjub.test.mjs fails on a
# missing file. Run it before `node --test test/jubjub.test.mjs`, or just use
# `npm test`, which runs both.
#
# No ceremony, no zkey: these harnesses are only ever witness-generated, never
# proved, so --r1cs --wasm --sym is the whole build.
set -euo pipefail

CIRCOM="${CIRCOM:-$HOME/.local/bin/circom}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # circuits/
OUT="$HERE/test/build"

command -v "$CIRCOM" >/dev/null 2>&1 || {
    echo "circom not found at '$CIRCOM'. Set CIRCOM=/path/to/circom." >&2
    exit 1
}

mkdir -p "$OUT"

for name in jubjub_add_test jubjub_dbl_test jubjub_check_test \
            jubjub_mulfix_test pedersen_commit_test; do
    echo "== compile $name (BLS12-381) =="
    "$CIRCOM" "$HERE/test/$name.circom" --r1cs --wasm --sym -p bls12381 -o "$OUT"
done

echo ""
echo "== DONE == test harnesses in $OUT"
