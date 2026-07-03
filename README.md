# Bullet

**send. silently.**

Bullet is a ZK-private payment rail on Stellar. Send USDC to any X handle
or email. Nothing on-chain connects your deposit to their claim.

Live demo: https://bullet-frontend.vercel.app

> Hackathon build (ZK track). Stellar testnet only. Own (non-MPC) trusted
> setup. Not audited. Not for mainnet funds.

---

## What the ZK actually does

Bullet's zero-knowledge proof is load-bearing: the app does not work
without it. Removing the proof does not just weaken privacy, it removes the
only mechanism the contract has to authorize a claim without revealing which
deposit is being claimed.

### The problem ZK solves

A normal payment on Stellar leaves a public edge: `sender_addr -> recipient_addr`.
Anyone watching the chain learns who paid whom, how much, and how often.

Bullet's contract holds a pool of **commitments** (`Poseidon(secret, recipientDigest, denom)`).
To claim, the recipient must convince the contract of three things at once:

1. "I know a secret whose commitment is somewhere in this pool" — without
   naming which commitment.
2. "That commitment is bound to me" — without revealing which recipient key
   it was bound to.
3. "I have not claimed this note before" — without linking the claim back to
   the deposit.

You cannot do this with a signature or a hash check. It has to be a proof.

### The circuit (`circuits/claim.circom`)

A Groth16 circuit over **BLS12-381** with 4 public inputs
(`[root, nullifier, recipientDigest, denom]`) and one private witness
(`[secret, pathElements[20], pathIndices[20]]`). The circuit enforces:

- **Merkle membership** — the leaf `Poseidon(secret, recipientDigest, denom)`
  hashes up through a depth-20 Poseidon-Merkle path to the public `root`.
- **Nullifier consistency** — the public `nullifier` equals
  `Poseidon(secret, recipientDigest)`, tying the claim to the note without
  revealing the note.
- **Denomination pinning** — the private witness's denom must equal the
  public `denom` the contract will pay out.

The nullifier is what makes the claim one-shot. The contract records every
nullifier it sees; a repeat is rejected. Same secret cannot claim twice.

### On-chain verification (`contracts/zeekpay/`)

The Soroban contract's `claim(proof_a, proof_b, proof_c, root, nullifier, recipient, denom)`
verifies the Groth16 proof using Stellar's native `bls12_381` host functions
(Protocol 22 / CAP-0059). Verification measured at **~70.66% of the 100M
per-tx instruction budget** on real testnet, with ~29% headroom.

If verification passes and the nullifier is unused, the contract:

1. Marks the nullifier used (single-use enforcement).
2. Transfers `denom` USDC from the pool to `recipient`.
3. Emits a `Claim` event.

**The `recipient` address on the claim tx has no on-chain link to the
`sender` on any deposit tx.** That is the privacy guarantee, and it exists
only because the proof lets the contract check ownership without needing
either address to appear together anywhere.

### Impact

Every ZK-shaped guarantee this project makes is verified end-to-end:

- `real_proof_verifies` (in `contracts/zeekpay/src/test.rs`) generates a
  real snarkjs proof for a real 4-input claim circuit and verifies it
  through the on-chain BLS12-381 host functions. Not a stub, not a mock.
- `pnpm build:circuits` runs the full pipeline: circom -> r1cs -> Groth16
  setup -> verification key -> converted Soroban fixture.
- The frontend hits the same code path in the browser: `POST /prove` calls
  snarkjs Groth16 in ~15 s, the browser signs and submits the claim, and
  the contract verifies it before releasing funds.

Take the ZK out and the contract has no way to distinguish "the right
recipient" from "anyone who wants the money." That is what "load-bearing"
means here.

---

## How it works, end to end

```
sender                       Soroban contract              recipient
 |  pick denom + handle          |                          |
 |  resolve handle -> pubkey     |                          |
 |  build commitment             |                          |
 |    Poseidon(secret,           |                          |
 |             recipientDigest,  |                          |
 |             denom)            |                          |
 |  deposit(commitment, denom) -->                          |
 |                               |  store commitment        |
 |                               |  emit Deposit event      |
 |                               |                          |
 |                               |  <-- scan inbox for note-|
 |                               |      (encrypted note     |
 |                               |       registry, sender   |
 |                               |       posts, recipient   |
 |                               |       decrypts)          |
 |                               |                          |
 |                               |  <-- claim(proof, root, -|
 |                               |          nullifier,      |
 |                               |          recipient,      |
 |                               |          denom)          |
 |                               |  verify Groth16 proof    |
 |                               |  check nullifier unused  |
 |                               |  mark nullifier used     |
 |                               |  pay recipient           |
 |                               |  emit Claim event        |
```

Deposits and claims are separate transactions with no shared field.

---

## Honest privacy limits

Bullet does not oversell. What is and is not private in v1:

- **Fixed denominations, not encrypted balances.** Amounts are standardized
  (1, 10, 50, 100 USDC), not hidden. Privacy comes from every payment
  looking the same size, not from concealing the number. Encrypted balances
  (Pedersen commitments + range proofs) are P3.
- **Anonymity scales with pool size.** At demo scale the set is small.
  We do not claim strong anonymity yet.
- **One-time commitments per payment.** Repeat payments to the same
  recipient land at independent spots. Strong cross-payment unlinkability
  needs stealth derivation (P1).
- **Merkle root is posted by a relayer (Option B trust seam).** On-chain
  Poseidon-Merkle insertion measured at ~4x over Soroban's per-tx budget,
  so the tree is built off-chain and an admin posts roots. A malicious
  root-poster could admit a forged tree. Decentralizing it is future work.
- **Trusted setup is single-contributor.** The hackathon uses our own
  Groth16 setup. Soundness assumes our randomness did not leak.
  Production path: MPC ceremony. Intermediate `ptau` files are toxic waste
  and never committed.
- **Delivery channels can be non-private.** Sender-authored encrypted
  notes (in the Supabase `notes` table) are decryptable only by the
  recipient's derived key, so the inbox is private. A copy-pasted claim
  link, or an email delivery path (P1), is trusted at the sender's
  discretion. On-chain unlinkability holds regardless.

---

## Stack

- **Contracts** — Rust + `soroban-sdk = 22.0.7` on Stellar testnet.
  `contracts/zeekpay/` (main) and `contracts/verifier/` (Groth16 verifier).
- **ZK** — Circom 2.2.3 + snarkjs 0.7.5, Groth16 over BLS12-381,
  depth-20 Poseidon Merkle, 11,420 constraints. `circuits/`.
- **Backend** — Node.js + Express + TypeScript. Resolver + `/prove` +
  `/post-root` + Supabase-backed user store. `backend/`.
- **Frontend** — Next.js 15 + Tailwind 4, `stellar-sdk` v16 + Freighter v6.
  `frontend/`.
- **Auth** — Supabase Auth (Google + X OAuth). Cookie sessions via
  `@supabase/ssr` on both frontend middleware and the backend `/me`,
  `/wallet/link` routes.
- **Asset** — USDC on Stellar testnet via Stellar Asset Contract.

## Repo layout

```
bullet/
├── SPEC.md          full spec, binding P0 scope
├── pipeline/        Plan -> Code -> Test -> Review artifacts per feature
├── contracts/       Cargo workspace: zeekpay, verifier
├── circuits/        Circom src, build, scripts
├── backend/         resolver + prove + post-root + Supabase user store
├── frontend/        Next.js app (Vercel)
├── shared/          shared TS types
└── scripts/         top-level dev scripts (deploy, e2e demo)
```

## Deployment

- **Frontend** on Vercel: https://bullet-frontend.vercel.app
- **Backend** on Railway: expose `NEXT_PUBLIC_RESOLVER_URL` to the frontend.
- **Contract** on Stellar testnet:
  `CC2RTZTQKONWFUFHZA3GT3VJGAQ2YCSEHFLIWMEZXQH65WQ5AWU5FW5R`
- **USDC SAC**:
  `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`

## Local setup

Node 20+ and pnpm 9. Rust + Soroban toolchain for the contracts.

```bash
cp .env.example .env    # fill in values; .env is gitignored
pnpm install
pnpm dev                # backend + frontend in parallel
```

Circuit regen (only needed if you change `circuits/claim.circom`):

```bash
pnpm build:circuits     # circom -> r1cs -> Groth16 setup -> vk -> fixture
```

## Development workflow

Every meaningful unit of work goes through a four-stage pipeline with
artifacts in `pipeline/<feature>/`: **Plan** (`spec.md`) -> **Code**
(`changes.md`) -> **Test** (`test-results.md`) -> **Review**
(`review.md`). See `SPEC.md` §9.

## Security notes

- Never commit secrets. `.env` is gitignored; `.env.example` carries
  placeholders only.
- Never commit trusted-setup toxic waste. Intermediate `ptau`
  contributions stay gitignored.
- `circuits/build/claim.zkey` and `circuits/build/claim_js/` are committed
  intentionally: they are public artifacts of a public setup, needed at
  runtime by the deployed backend. If the setup is ever re-run (MPC
  ceremony), those files must be replaced.
- Testnet only. Own (non-MPC) trusted setup. Not audited.
