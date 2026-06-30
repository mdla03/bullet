# repo-scaffold — Code (changes.md)

## Files created

### Critical (secrets / safety)
- `.gitignore` — full coverage: secrets, trusted-setup toxic waste, Rust/Circom/Node/Next/TS build artifacts, tooling noise. Created **before** any `git add`. `pipeline/` deliberately NOT ignored.
- `.env.example` — ~15 required keys, all blank values, grouped (Stellar/Soroban, deployer, resolver, X OAuth, SendGrid, frontend `NEXT_PUBLIC_*`).

### Root
- `package.json` — pnpm workspaces, `packageManager: pnpm@9.7.0`, `engines` Node 20 / pnpm 9, script stubs (`dev`, `build`, `build:circuits`, `deploy:testnet`). No `license` field (per owner: omit).
- `pnpm-workspace.yaml` — members: `backend`, `frontend`, `shared`.
- `.vscode/settings.json` — shared editor settings (format on save, rust-analyzer linked to `contracts/Cargo.toml`). Only file un-ignored under `.vscode/`.
- `README.md` — stub: what it is, **honest privacy notes**, stack, layout, setup, security.

### Contracts (Cargo workspace, compilable empty libs)
- `contracts/Cargo.toml` — workspace, members `zeekpay`/`verifier`, shared `[workspace.package]`, release profile tuned for Soroban (`opt-level=z`, `lto`, `overflow-checks=true`, `panic=abort`). No deps yet.
- `contracts/zeekpay/Cargo.toml` + `src/lib.rs` — empty `std` stub, `cdylib`+`rlib`. (`#![no_std]` + soroban-sdk added in `soroban-contract`.)
- `contracts/verifier/Cargo.toml` + `src/lib.rs` — empty `std` stub. (`#![no_std]` + deps added in `verifier-benchmark`.)

### JS workspaces (stubs)
- `shared/package.json` + `src/index.ts` — `@zeekpay/shared`, empty export.
- `backend/package.json` + `src/index.ts` — `@zeekpay/backend`, depends `@zeekpay/shared` (`workspace:*`).
- `frontend/package.json` — `@zeekpay/frontend`, depends `@zeekpay/shared`.

### Placeholders
- `circuits/{src,build,scripts}/.gitkeep`, `scripts/.gitkeep`.

## `.gitignore` updates
Entire file created this feature (it IS the artifact).

## Deviations from spec.md
- **Crate stubs are `std`, not `#![no_std]`.** Test stage found `#![no_std]`
  empty libs fail to build on the host target (no panic handler). `no_std` +
  soroban-sdk are added in the contract features, built for wasm32. Honors the
  owner's "compilable empty libs" intent.
- **`.gitignore` inline comments moved to their own lines.** Trailing `# ...`
  comments broke the `final.ptau` and `settings.json` negations (git treats the
  comment text as part of the pattern). Fixed in Test stage.

All 3 open questions resolved by owner: (1) compilable empty libs ✓, (2) pin packageManager + engines ✓, (3) omit license ✓.

## New dependencies
None. Scaffold is dependency-free by design (soroban-sdk, snarkjs, next, etc. added in their own features). No install of heavy/crypto libs.

## Known gaps / TODOs
- `pnpm install` not yet run (no real deps to fetch; lockfile generated in Test stage).
- No CI yet (out of scaffold scope).
- Crate stubs are `#![no_std]` with no `soroban-sdk` — `cargo build` compiles them as plain empty libs; Soroban wiring is `soroban-contract`/`verifier-benchmark`.
