# repo-scaffold — Test (test-results.md)

Scaffold has no product logic, so testing targets the three things that can
actually go wrong in a scaffold: **does it build**, **does the workspace wire
up**, and **does `.gitignore` actually protect secrets + toxic waste**.

## Environment
- `cargo 1.83.0` ✓
- `node v22.22.3` (note: env runs Node 22; `engines` pins `>=20 <21` — see gaps)
- `pnpm` not on PATH; enabled via `corepack pnpm@9.7.0` ✓

## 1. Cargo workspace builds
Command:
```
cargo build --manifest-path contracts/Cargo.toml
```
First run FAILED:
```
error: `#[panic_handler]` function required, but not found
error: unwinding panics are not supported without std
error: could not compile `zeekpay` (lib) due to 2 previous errors
```
**Cause:** `#![no_std]` stubs need an SDK-provided panic handler + wasm32 target;
they can't compile as plain host libs. **Fix:** dropped `#![no_std]` from the
stubs (added back with `soroban-sdk` in `soroban-contract`/`verifier-benchmark`).
Re-run PASSED:
```
   Compiling verifier v0.0.0
   Compiling zeekpay v0.0.0
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.54s
```

## 2. pnpm workspace wires up
Command:
```
corepack pnpm install
```
Output:
```
Scope: all 4 workspace projects
Already up to date
Done in 184ms
```
4 projects detected (root + backend/frontend/shared), `workspace:*` deps link. ✓

## 3. `.gitignore` protects secrets + toxic waste  ← the critical test
Method: `git check-ignore -q <path>` over a matrix of paths that MUST be ignored
and paths that MUST stay tracked.

### First run — TWO FAILURES (bug found)
```
!! IGNORED circuits/build/final.ptau      (should be TRACKED)
!! IGNORED .vscode/settings.json          (should be TRACKED)
```
**Cause:** git does **not** support trailing inline comments. The text after `#`
on a pattern line becomes part of the pattern, so the negations
`!circuits/build/final.ptau   # ...` and `!.vscode/settings.json   # ...` never
matched. **Fix:** moved both comments to their own lines.

### Re-run — ALL PASS
MUST be ignored (all `IGNORED`):
```
.env  .env.local  .env.production  secrets.secret  stellar-keys/k.txt
circuits/build/0001.ptau  circuits/build/pot12_contribution_3.ptau
circuits/build/contributions/x  circuits/build/circuit.r1cs
circuits/build/circuit.sym  circuits/build/circuit_js/gen.wasm
contracts/target/debug/x  node_modules/x  frontend/.next/x  dist/x
app.log  .DS_Store  .vscode/launch.json
```
MUST be tracked (all `TRACKED`):
```
.env.example  circuits/build/final.ptau  .vscode/settings.json
pipeline/repo-scaffold/spec.md  SPEC.md  README.md
circuits/build/verification_key.json
```

## 4. What would actually be committed
```
git add -A --dry-run
```
25 files. `node_modules` leak: 0. `target` leak: 0. Lockfiles
(`Cargo.lock`, `pnpm-lock.yaml`) tracked as expected. No `.env`, no `*.ptau`
contribution, no build artifact in the set.

## Adversarial / edge cases covered
- ✓ `.env.*` glob ignored but `!.env.example` survives the glob.
- ✓ ptau contributions (`*_contribution_*`, `contributions/`) ignored; only
  `final.ptau` survives — the toxic-waste protection works.
- ✓ Negation-with-inline-comment failure mode (the real bug) caught and fixed.

## Not tested yet (and why)
- `pnpm dev`/`build`/`deploy:testnet` — placeholders that only echo; nothing to
  assert until their features land.
- wasm32 / Soroban build — no SDK in scaffold by design; covered in
  `verifier-benchmark`.
- No CI — out of scaffold scope.
