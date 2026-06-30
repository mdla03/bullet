# ZeekPay

ZK-private payment rail on Stellar. Send USDC to an **X handle** or **email**
instead of a wallet address — without exposing the **sender↔recipient link**
on-chain.

> **Status:** hackathon build (ZK track). Testnet only. Not audited. Not for
> mainnet funds.

## How it works (one paragraph)

You pick an amount and a recipient handle. The app resolves the handle to the
recipient's published key, builds a **one-time commitment**, and deposits a
**fixed-denomination note** (1 / 10 / 50 / 100 USDC) into the Soroban contract.
The recipient later proves — in their browser, with a zero-knowledge proof —
that they own a note, and claims it to any address. No on-chain field links the
deposit to the claim.

## Honest privacy notes (read this)

ZeekPay does **not** oversell. What is and isn't private in v1:

- **Fixed denominations, not encrypted balances.** Amounts are *standardized*,
  not hidden. A 50 USDC note is a visible 50 USDC transfer. Privacy comes from
  everyone using the same sizes, so no single payment stands out — not from
  hiding the number. Full encrypted/shielded balances (Pedersen commitments +
  range proofs) are **P3**, not v1.
- **Anonymity scales with pool size.** At demo scale the anonymity set is small.
  We do not claim strong anonymity.
- **One-time commitments per payment.** Repeat payments to the same recipient
  land at independent spots. Strong cross-payment unlinkability needs **stealth
  derivation, which is P1** — until it lands, repeat-payment unlinkability is
  weaker.
- **Email is a trusted convenience channel.** If you deliver a claim link by
  email, the email provider (SendGrid, P1) **sees the claim link**. On-chain
  unlinkability still holds; the delivery path is trusted. Privacy-maximizing
  users can use the copy-paste link instead.
- **X delivery is manual copy-paste by design** — no automated DMs (spam risk).
- **Merkle root is posted by a relayer (Option B trust seam).** On-chain
  Poseidon-Merkle insertion does not fit Soroban's instruction budget
  (benchmarked at ~4× over), so the commitment tree is built off-chain and a
  relayer/admin posts roots on-chain. A malicious root-poster could admit a
  forged tree. Decentralizing this (or an on-chain incremental tree with a
  cheaper hash) is future work.
- **Trusted setup.** The hackathon uses **our own Groth16 setup**. That is a
  trust assumption: soundness depends on our setup randomness not leaking. The
  production path is a multi-party MPC ceremony. Intermediate `ptau`
  contributions are **toxic waste** and are never committed.

## Stack

- **Contracts:** Rust + Soroban SDK (Stellar testnet) — `contracts/`
- **ZK:** Circom + snarkjs, **Groth16 over BLS12-381** (benchmarked at ~70% of Soroban's per-tx instruction budget — verified on-chain via native `bls12_381` host functions) — `circuits/`
- **Backend:** Node.js + TypeScript (resolver, X OAuth, SendGrid P1) — `backend/`
- **Frontend:** Next.js + TS + Tailwind, `stellar-sdk` + Freighter — `frontend/`
- **Shared types:** `shared/`
- **Asset:** USDC on Stellar testnet via SAC

## Repo layout

```
zeekpay/
├── SPEC.md          # full spec — binding P0 scope
├── pipeline/        # Plan→Code→Test→Review artifacts per feature (committed)
├── contracts/       # Cargo workspace: zeekpay (main), verifier (Groth16)
├── circuits/        # Circom src / build / scripts
├── backend/         # resolver, X OAuth, SendGrid (P1)
├── frontend/        # Next.js app
├── shared/          # shared TS types
└── scripts/         # top-level dev scripts (deploy, e2e demo)
```

## Setup

Requires **Node 20 LTS** + **pnpm 9** (JS) and the **Rust / Soroban** toolchain
(contracts).

```bash
cp .env.example .env     # fill in values; .env is gitignored, never commit it
pnpm install
```

Root scripts (most are placeholders until their features land):

```bash
pnpm dev              # backend + frontend in parallel
pnpm build            # build all JS workspaces
pnpm build:circuits   # compile circuits (circom-circuit feature)
pnpm deploy:testnet   # deploy contracts (soroban-contract / e2e-demo)
```

## Development workflow

Every meaningful unit of work goes through a four-stage pipeline, with artifacts
in `pipeline/<feature>/`: **Plan** (`spec.md`) → **Code** (`changes.md`) →
**Test** (`test-results.md`) → **Review** (`review.md`). See `SPEC.md` §9.

## Security

- **Never commit secrets.** Secrets live in `.env` (gitignored); keys are listed
  blank in `.env.example`.
- **Never commit trusted-setup toxic waste.** Intermediate `ptau` contributions
  stay gitignored.
- Testnet only. Own (non-MPC) trusted setup. Not audited.
