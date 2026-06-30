# repo-scaffold — Plan (spec.md)

## What & why
First pre-product gate. Produces the monorepo skeleton **and a correct
`.gitignore` BEFORE any secret or build artifact can land**. No product code.
Maps to SPEC.md §4 pre-product gates (`repo-scaffold`).

## Public interface
Not a code feature — interface is the repo layout + root scripts.

### Root `package.json` scripts (stubs that no-op or echo until features land)
- `pnpm dev` — run backend + frontend in parallel (placeholder until those exist)
- `pnpm build` — build all JS workspaces
- `pnpm build:circuits` — placeholder, wired in `circom-circuit`
- `pnpm deploy:testnet` — placeholder, wired in `soroban-contract`/`e2e-demo`

### pnpm workspaces
`pnpm-workspace.yaml` → `backend`, `frontend`, `shared`.

## Files created
```
zeekpay/
├── README.md                 # stub: what ZeekPay is + honest privacy note + setup
├── .gitignore                # full coverage (see below) — THE critical artifact
├── .env.example              # every required key, values blank
├── package.json              # root, pnpm workspaces + script stubs
├── pnpm-workspace.yaml
├── .vscode/settings.json     # shared editor settings (committed)
├── contracts/
│   ├── Cargo.toml            # workspace, members: zeekpay, verifier
│   ├── zeekpay/              # crate stub (lib.rs placeholder, no product logic)
│   └── verifier/             # crate stub
├── circuits/
│   ├── src/.gitkeep
│   ├── build/.gitkeep
│   └── scripts/.gitkeep
├── backend/
│   └── package.json          # @zeekpay/backend stub
├── frontend/
│   └── package.json          # @zeekpay/frontend stub
├── shared/
│   └── package.json          # @zeekpay/shared stub
└── scripts/.gitkeep
```
`SPEC.md` and `pipeline/` already exist — not recreated, not gitignored.

## `.gitignore` — full required coverage (verbatim from kickoff brief)

**Secrets (critical):**
```
.env
.env.local
.env.*
!.env.example
*.secret
stellar-keys/
```

**Trusted-setup toxic waste (critical):**
Intermediate ptau / phase-2 contribution files contain private randomness that,
if leaked, compromise soundness of every proof. Default to ignoring any setup
artifact whose safety is unclear, and ask the owner.
```
circuits/build/*.ptau
!circuits/build/final.ptau      # only final, public ptau safe to commit if needed
circuits/build/contributions/
circuits/build/*_contribution_*
```

**Build artifacts:**
```
# Rust / Soroban
contracts/target/
**/*.rs.bk

# Circom intermediates (keep final .wasm, .zkey, verification_key.json if needed)
circuits/build/*.r1cs
circuits/build/*.sym
circuits/build/*_js/

# Node
node_modules/
pnpm-lock.yaml.bak
.pnpm-store/

# Next.js
.next/
out/

# TypeScript
dist/
*.tsbuildinfo
```

**Tooling noise:**
```
.DS_Store
Thumbs.db
*.log
pnpm-debug.log*
.vscode/*
!.vscode/settings.json
.idea/
```

`pipeline/` is NOT ignored (committed paper trail).

## `.env.example` keys (blank values)
Template only; real `.env` gitignored. Planned keys:
```
# Stellar / Soroban
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=
ZEEKPAY_CONTRACT_ID=
USDC_SAC_ID=
# Deployer (NEVER commit real value)
DEPLOYER_SECRET_KEY=
# Backend resolver
RESOLVER_PORT=
DATABASE_URL=
# X OAuth (x-oauth-identity feature)
X_CLIENT_ID=
X_CLIENT_SECRET=
X_OAUTH_CALLBACK_URL=
# SendGrid (P1)
SENDGRID_API_KEY=
# Frontend
NEXT_PUBLIC_SOROBAN_RPC_URL=
NEXT_PUBLIC_CONTRACT_ID=
NEXT_PUBLIC_RESOLVER_URL=
```

## Security-sensitive assumptions
- `.gitignore` must exist and be correct **before** first `git add`. Verify no
  secret/toxic-waste pattern is trackable after scaffold (test stage greps).
- `.env.example` carries **no real values** — placeholders only.
- No private keys, no ptau, no real credentials generated in this feature.

## New `.gitignore` entries this feature adds
The entire `.gitignore` (this feature creates it).

## Open questions
1. **Cargo crate stubs:** make `zeekpay`/`verifier` compile as empty `lib`
   crates now (so `cargo build` passes), or leave bare `Cargo.toml` + empty
   `lib.rs`? Recommend compilable empty libs — keeps CI green from day 1.
2. **Node version / package manager pin:** pin `packageManager` field +
   `engines` in root `package.json`? Recommend yes (pnpm + Node 20 LTS).
3. **License field** in README/package.json — any preference, or omit for now?

No code until you OK this spec.
