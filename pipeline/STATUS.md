# ZeekPay — Project Status (session handoff)

Last updated: 2026-07-01. Demo deadline: 2026-07-07.
ZeekPay = ZK-private payment rail on Stellar; pay an X handle / email without
exposing the sender↔recipient link on-chain. Fixed-denomination notes (1/10/50/
100 USDC), Tornado-style amount-unlinkability, NOT encrypted balances.

## 1. Locked decisions (with rationale)
- **Proof system: Groth16** — fits Soroban budget; PLONK/off-chain-attestation
  fallbacks unneeded.
- **Curve: BLS12-381** — Soroban has native `bls12_381` host functions (Protocol
  22 / CAP-0059); BN254 has none (would run in wasm → too costly).
- **On-chain verify cost: ~70.66% of the 100M per-tx CPU budget** (real testnet),
  ~29% headroom. Each extra public input ≈ +1.5M instructions.
- **Commitment model: Option B (off-chain Merkle).** On-chain Poseidon-Merkle
  insert benchmarked at depth-20 = 401.9% = 4× over budget → Option A dead.
  Deposit just stores commitment + emits event; a relayer/admin posts roots via
  `post_root`; claim proves membership vs a contract-known root.
- **Option B trust seam:** the root-poster is trusted (could admit a forged
  tree). Documented in README honest-limits. Decentralizing it is future work.
- **Trusted setup:** our own (non-MPC) Groth16 setup for the hackathon; intermediate
  ptau is toxic waste and gitignored; production path = MPC ceremony.
- **soroban-sdk pinned `=22.0.7`** — first series with bls12_381 host fns.
- **Byte encoding (snarkjs → Soroban), PROVEN correct by a real-proof test:**
  G1 = BE(X)||BE(Y) (96B); G2 = BE(X_c1)||BE(X_c0)||BE(Y_c1)||BE(Y_c0) (192B, note
  c1 BEFORE c0); Fr = BE (32B). snarkjs stores Fp2 as [c0,c1] → converter swaps.
- **Contract⇄circuit public-input interface (LOCKED):** claim public inputs =
  `[Fr(root), Fr(nullifier), Fr(recipient_digest), Fr(denom)]` where
  `recipient_digest = sha256(recipient.to_xdr)` with the top byte zeroed (< r),
  and `denom` is its u32 (1/10/50/100). The circom claim circuit MUST match this
  exactly or every real proof fails.

## 2. Completed features (commit hashes)
- `94fdf4e` **repo-scaffold** — monorepo skeleton, pnpm workspaces
  (backend/frontend/shared/circuits), Cargo workspace, `.gitignore` (verified via
  git check-ignore; fixed inline-comment bug that broke negations), `.env.example`,
  README, `.vscode/settings.json`. Builds green.
- `423a01a` **verifier-benchmark** — Groth16 fits (~70% via host budget meter);
  real BLS12-381 proof generated + verified off-chain.
- `02e23d7` **verifier-benchmark testnet confirm** — real testnet 70.66%; proof
  system locked; recorded in SPEC §6 + README.
- `24d89e7` **soroban-contract Option-A benchmark** — on-chain Poseidon-Merkle
  insert = NO-GO (4× over). Recommended Option B.
- `7ac0be2` **soroban-contract Plan finalized for Option B.**
- `de99d5a` **soroban-contract** — deposit/post_root/claim/nullifier storage/fixed
  denoms/events. Real Groth16 verifier (src/verifier.rs) proven by a real snarkjs
  proof verifying `true` (src/test.rs `real_proof_verifies`). 9 tests pass (3
  real-verifier + 6 adversarial: double-spend, unknown root, paused, uninit, admin
  auth, happy path) via a cfg(test)-only verify bypass excluded from the 19K wasm.
- `25e205f` **circom-circuit** — real Poseidon-Merkle claim circuit (depth-20,
  BLS12-381, 11,420 constraints). Public inputs = [root, nullifier, recipientDigest,
  denom] matching soroban-contract LOCKED interface. `real_proof_verifies` in
  zeekpay now tests a 4-input claim proof through the bls12_381 host fns —
  end-to-end gap from soroban-contract closed. WASM still 19K (verify bypass
  excluded). `pnpm build:circuits` is now the real build pipeline.
- `f2b07df` **resolver-service** — Express 5 + TypeScript handle/email → Stellar
  address resolver. GET /health, GET /resolve?q=, POST /register. In-memory Map +
  JSON persistence (no DB). 19 tests pass (store unit + HTTP integration). Signature
  stored but not yet verified (deferred to x-oauth-identity).
- `dce3498` **x-oauth-identity** — Ed25519 Freighter sig verification + Twitter
  OAuth 2.0 PKCE registration gate. POST /auth/twitter/start verifies sig and returns
  authUrl; GET /auth/twitter/callback verifies X identity and writes to registry.
  Challenge = `"zeekpay-register-v1:{handle}:{stellarAddress}"`. 5-min TTL pending
  map. 33 tests pass (14 new, no regressions). Requires one-time Twitter dev app setup.
- `83d781e` **frontend-send** — Next.js `/send` page: resolve handle → Freighter
  connect → compute recipientDigest + commitment (via backend snarkjs child process) →
  deposit Soroban note → display shareable claim link. Backend: `POST /commitment` route +
  CORS. Frontend: new Next.js 15 app (Tailwind v4, stellar-sdk v16, Freighter API v6).
  Build: `next build` clean (33 backend tests still pass).
- `06683c2` **frontend-inbox** — `/claim?p=...` page: decode claim link →
  note card ($X USDC, network, contract) → connect Freighter → verify recipientDigest
  matches connected wallet → disabled "Claim" stub (frontend-claim implements execution).
  Build clean; 33 backend tests still pass.
- `b86f28e` **frontend-claim** — Full claim execution: `POST /prove` (snarkjs
  Groth16 ~15 s, single-leaf Merkle path) + `POST /post-root` (admin stellar-sdk call) +
  Soroban `claim(proof_a, proof_b, proof_c, root, nullifier, recipient, denom)` via
  Freighter + tx polling. Backend tsc clean; `next build` clean (295 kB /claim bundle).
- `53b486c` **fix: ROOT path** — `prove.ts` + `commitment.ts` used 4 `..` traversals
  (landed above repo root); corrected to 3.
- (pending commit) **e2e-demo** — Contract deployed + VK set on testnet.
  Contract: `CC2RTZTQKONWFUFHZA3GT3VJGAQ2YCSEHFLIWMEZXQH65WQ5AWU5FW5R`.
  XLM SAC: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`.
  POST /prove + POST /post-root verified working end-to-end.
  Browser demo requires Freighter + funded testnet account.

Each feature has Plan→Code→Test→Review artifacts under `pipeline/<feature>/`.

## 3. Exact next feature to start
**All planned features complete.** Run the browser demo using instructions below.

## 4. Open follow-ups / known gaps (verbatim)
- **CLOSED** End-to-end claim with a REAL 4-input proof — `real_proof_verifies`
  now validates a real Groth16 claim proof through bls12_381 host fns. ✓
- **CLOSED** Nullifier TTL/rent: `claim` now bumps the nullifier TTL (~173 days,
  under mainnet `max_entry_ttl`) and `post_root` bumps each root + ring slot, so
  neither archives out from under a valid claim. `claim_bumps_nullifier_and_root_ttl`
  asserts both. Note: persistent entries still archive on the long tail (restore
  preserves value, so replay stays blocked); true permanence needs periodic
  re-bump before any high-value non-demo use. ✓
- `Fr::from_bytes` with root/nullifier ≥ r — caller-supplied edge; behavior
  (panic vs reduce) to confirm; a panic would be a DoS (not fund loss).
- vk is set post-deploy via `set_vk`; the real claim-circuit vk (claim_vk.json,
  4 public inputs) must replace the benchmark vk during e2e-demo.
- BN254 Poseidon constants used over BLS12-381 field — acceptable for hackathon;
  production path: native BLS12-381 Poseidon (documented in circom-circuit review).
- Trusted setup is single-contributor (pot14). Production path: MPC ceremony.
- Real testnet fee for the full claim deferred to e2e-demo (free via Friendbot).

## 5. Environment / setup facts a fresh session needs
- Working dir: `/Users/mark03/Developer/personal-projects/bullet` (git repo, branch
  `master`; commit only when the user asks).
- Node v22 (engines pin `>=20`); pnpm via `corepack pnpm` (pinned `pnpm@9.7.0`);
  `pnpm-workspace.yaml` members: backend, frontend, shared, circuits.
- Rust: use rustup toolchain, NOT Homebrew rust (1.83 fails edition2024 transitive
  deps). PATH must front `$HOME/.cargo/bin`: `export PATH="$HOME/.cargo/bin:$PATH"`.
  rustup stable = 1.96.x; `wasm32-unknown-unknown` target installed.
- circom 2.2.3 at `~/.local/bin/circom` (macOS amd64 binary via Rosetta; arm64 host).
- stellar-cli 27.0.0 via Homebrew (`/opt/homebrew/bin/stellar`).
- Cargo builds: `cargo build --manifest-path contracts/Cargo.toml ...`. Tests:
  `cargo test --manifest-path contracts/Cargo.toml -p <crate>`.
- Circuit/proof regen: `bash circuits/scripts/build-claim.sh` (compiles
  claim.circom, generates pot14 if missing, runs Groth16 setup, exports
  claim_vk.json, generates test proof, runs convert-to-soroban.mjs →
  groth16_soroban.json + contracts/zeekpay/src/groth16_fixture.rs).
  Or `pnpm build:circuits` from repo root (same thing).
  Legacy benchmark: `bash circuits/scripts/run-benchmark.sh` (preimage circuit only).
- **Testnet = free** (Friendbot test XLM, no real money). Throwaway identity
  `zeekpay-bench` stored in `~/.config/stellar/identity/` (OUTSIDE repo, not
  committed). Network alias `testnet` is built into stellar-cli. **User requires
  ZERO monetary cost** — prefer free/offline paths; never use mainnet/paid APIs.
- Deployed bench contracts (testnet, reference only):
  verifier `CCNJPUHMJEIJC4IKONJHBZ2RQ4GZQ5HR7BQMLWWQW6HD4SW3IYKAVOBT`;
  Poseidon-merkle bench `CDQIYJYAVR3OWQC32V4NZOHERIIVMJEPKH32RKWUGHV6M2NQI3WYTQWV`.
- Toxic waste: `*.ptau` (incl. final.ptau 6.8M, pot14_final.ptau 27M), `*.zkey`,
  `*.wtns`, `**/test_snapshots/` are gitignored. Tracked artifacts: tiny JSON
  (claim_vk.json, claim_proof.json, claim_public.json, claim_input.json,
  groth16_soroban.json). Never commit files >1MB without asking.
- GitHub: private repo `https://github.com/mdla03/bullet` (origin/master).
  Push with `git push`.

## 6. Source of truth
For anything not covered here, read `SPEC.md` (binding P0 scope + design) and the
per-feature `pipeline/<feature>/{spec,changes,test-results,review}.md` artifacts.
