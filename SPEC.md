> **Status:** DRAFT for approval. Synthesized from the hackathon kickoff brief.
> **Demo deadline:** 2026-07-07 (ZK track, extended by one week from original June 29).
> **Binding scope:** the **P0** list below. P1/P2/P3 are explicitly out of scope
> unless the project owner says otherwise in writing.

---

## 1. What ZeekPay is

ZeekPay is a **ZK-private payment rail on Stellar**. It lets a sender pay
USDC/XLM to a **social handle (X) or email** instead of a wallet address, while
hiding the **sender↔recipient link** on-chain.

Privacy model (v1, stated plainly — do not oversell):

- **One-time per-recipient commitments.** Each payment lands at a one-time spot
  derived from the recipient's published key, not in a shared per-handle wallet.
  Ten payments = ten separate notes. This is what gives unlinkability across
  payments to the same recipient.
- **Fixed-denomination notes (1, 10, 50, 100 USDC) for amount unlinkability.**
  Same trick Tornado Cash uses, but applied to amount-matching only: because
  every deposit and claim is an identical round number, the amount carries no
  information you can match on, so it cannot be used to re-link a deposit to a
  claim.
- **NOT encrypted balances.** The amount is standardized, not hidden. A 50 USDC
  note is still a visible 50 USDC transfer. Privacy comes from everyone using
  the same sizes, so no single payment stands out. A larger payment is composed
  from several notes (UX cost).
- **The fully encrypted version is P3, not v1.** Pedersen commitments + range
  proofs inside a shielded pool is the real destination for amount privacy.
  It's deferred because a pool is security-critical (a flawed range proof or
  balance check lets someone withdraw more than they deposited) and only
  meaningful at real volume, not demo scale.
- **Email is a convenience channel only.** When delivery goes over email, the
  email provider (SendGrid, P1) **sees the claim link**. The on-chain
  unlinkability still holds; the off-chain delivery path is trusted. README
  must say this.
- **Trusted setup:** the hackathon uses our **own Groth16 setup**. This is fine
  for a demo but is a trust assumption. README points at a future MPC ceremony
  as the production path. Intermediate `ptau` contributions are **toxic waste**
  and must never be committed.

---

## 2. Core flow
Sender                         Contract (Soroban)              Recipient
|  pick denom + handle/email      |                              |
|  resolve handle -> recipient    |                              |
|  build one-time commitment      |                              |
|  from recipient's published key |                              |
|  deposit(commitment, denom) ----> store commitment              |
|                                  |  emit Deposit event         |
|                                  |                              |
|                                  |   <--- scan w/ viewing key --|
|                                  |        find claimable note   |
|                                  |                              |
|                                  |   <--- claim(proof, ----------|
|                                  |        nullifier, recipient) |
|                                  |  verify proof                |
|                                  |  check nullifier unused      |
|                                  |  mark nullifier used         |
|                                  |  pay recipient               |
|                                  |  emit Claim event            |

No on-chain field links the `deposit` tx to the `claim` tx. Repeat payments to
the same recipient land at independent one-time commitments and do not look
related on-chain.

---

## 3. Delivery channels (three paths, by design)

How the recipient learns they were paid depends on who they are:

- **Registered user (hero flow).** No notification needed. The user opens the
  app and their **private inbox** scans the contract with their viewing key,
  showing claimable notes. The money simply appears.
- **Unregistered, paid by email.** Claim link auto-sent via SendGrid (P1,
  hands-off for the sender).
- **Unregistered, paid by X handle.** **Copy-paste only, by design.**
  Automated DMs get flagged as spam, so the app hands the sender a
  ready-to-send message containing the claim link and the sender delivers it
  themselves. Zero X API risk, and it arrives from someone the recipient
  actually knows. Do not "improve" this into an automated DM later — it's a
  deliberate choice.

---

## 4. P0 scope (BINDING)

Build order; each is its own pipeline feature (Plan→Code→Test→Review).

**Pre-product gates (do first):**

- `repo-scaffold` — monorepo skeleton, `.gitignore`, `.env.example`, root
  `package.json` with pnpm workspaces, empty Cargo workspace, README stub.
  **No product code.**
- `verifier-benchmark` — answer the single biggest risk: **does a Groth16
  verifier fit inside Soroban's instruction budget?** Trivial Poseidon-preimage
  proof, measure instructions / % of budget / fee per verify on testnet.
  **Hard stop for owner go/no-go on the proof system before any product code.**
  If Groth16 doesn't fit, **PLONK on-chain or off-chain verify + on-chain
  attestation is the immediate fallback** and becomes part of P0, not a future
  roadmap item.

**P0 features (after verifier decision):**

1. `soroban-contract` — `deposit`, `claim`, nullifier storage, fixed
   denominations (1/10/50/100 USDC), event emission.
2. `circom-circuit` — Poseidon preimage + nullifier proof, minimal so in-browser
   proving stays fast.
3. `resolver-service` — handle/email → `{contract address, asset, recipient public key}`.
4. `x-oauth-identity` — X OAuth login; derive ZeekPay keys from a Freighter
   signature; publish identifier + key.
5. `frontend-send` — send form (Next.js).
6. `frontend-inbox` — registered private inbox: scan contract with viewing key,
   list claimable notes.
7. `frontend-claim` — claim page, snarkjs proof gen in WASM.
8. `copy-paste-claim-link` — unregistered recipient flow. **No X API, no email
   yet** (SendGrid is P1).
9. `e2e-demo` — testnet explorer links showing deposit tx + claim tx with no
   visible link between them.

---

## 5. Out of scope (do NOT build without explicit OK)

**P1 — strongly want, do if time allows:**
- **Stealth derivation** so repeat payments to the same handle do not link to
  each other across multiple payments. Most important P1 because it makes the
  privacy claim true at scale, not just for a single transaction. Touches the
  crypto — scope carefully.
- SendGrid automated email delivery (the one fully automated channel; X stays
  manual copy-paste by design).
- On-chain announcements (contract events) so an owner can reliably scan and
  find their payments.
- Cleaner claim UX: loading states during proof generation, claim-secret
  recovery if delivery fails.

**P2 — roadmap, next build after the hackathon:**
- On-chain identity registry (decentralize the handle/email → key mapping
  instead of off-chain resolver).
- Scan optimizations (view tags, borrowed from ERC-5564 stealth-address world).
- More delivery channels (QR code fallback, shareable claim card).

**P3 — future and vision:**
- **Full shielded pool for arbitrary amounts:** encrypted internal balances
  with Pedersen commitments and range proofs. The real destination for amount
  privacy. Deferred because pools are security-critical and only meaningful at
  real volume.
- Mainnet deployment with proper multi-party trusted setup ceremony.
- Multi-asset support beyond USDC/XLM.
- **Compliance tooling:** view keys and selective disclosure so a user can
  prove a payment to a regulator/auditor without making it public. This is the
  thing that makes the private rail viable for institutions.
- **Programmatic payers:** keep the send as a clean callable function so
  automated/scheduled payers could integrate later. Keep the door open, don't
  build now.

Reaching for any of these = stop and ask.

---

## 6. Architecture

| Layer | Tech | Notes |
|-------|------|-------|
| Contracts | Rust + Soroban SDK, Stellar testnet | `zeekpay/` main, `verifier/` Groth16 verifier (or day-1 benchmark stub) |
| ZK | Circom + snarkjs, Groth16 (PLONK or off-chain attestation as immediate fallback if benchmark fails) | in-browser proving via WASM |
| Backend | Node.js + TypeScript | resolver, X OAuth, SendGrid (P1) |
| Frontend | Next.js + TS + Tailwind, `stellar-sdk`, Freighter | wallet integration |
| Asset | USDC on Stellar testnet via SAC | |

Monorepo, pnpm workspaces for JS (`backend`, `frontend`, `shared`). Cargo
workspace for `contracts/`. Repo layout per kickoff brief.

---

## 7. ZK / cryptographic design (security-sensitive)

**Proof system (LOCKED, verifier-benchmark 2026-06-30):** **Groth16 over
BLS12-381**, verified on-chain via Soroban's native `bls12_381` host functions.
A Groth16 verify (4-pair pairing_check + IC MSM) measured **70.66% of the 100M
per-tx CPU instruction budget on testnet** (~29% headroom; fee ~0.006 XLM). The
PLONK / off-chain-attestation fallbacks are NOT needed. In-browser proving uses
snarkjs over BLS12-381.

Detailed design decisions are finalized in each feature's `spec.md`. The
high-level shape:

- **One-time commitment per payment**, derived from the recipient's published
  key plus per-payment randomness. Exact preimage layout (e.g.
  `C = Poseidon(...)`) finalized in `circom-circuit` spec.
- **Nullifier** revealed at claim. Contract stores used nullifiers; a second
  claim with the same nullifier is rejected. **A flawed nullifier check is how
  funds get drained twice** — adversarial tests required.
- **Proof statement (claim):** "I know the secret behind this commitment and
  this nullifier is its correctly-derived nullifier." Exact public-input
  binding (e.g. whether the recipient address is bound into the proof to
  prevent front-running/re-targeting) is decided in `circom-circuit` spec, not
  assumed here.
- **Key derivation:** ZeekPay viewing/spending keys derived from a Freighter
  signature over a fixed domain-separated message. Finalized in
  `x-oauth-identity`.
- **Trusted setup:** own Groth16 ceremony for the hackathon; `final.ptau` /
  `verification_key.json` may be committed; **all intermediate contributions
  are toxic waste and gitignored.**

Every feature touching circuit / verifier / nullifier / key derivation flags
the assumption in its `spec.md` and `review.md`.

---

## 8. Threat model (honest limits)

- **On-chain:** deposit↔claim unlinkable. One-time commitments mean repeat
  payments to the same recipient also don't link to each other on-chain
  (assuming stealth derivation, which is P1 — without it, repeat-payment
  unlinkability is weaker until P1 lands).
- **Amount privacy:** standardized via fixed denominations, not encrypted.
  The number is public; the trick is everyone uses the same sizes.
- **Off-chain:** resolver and email provider are trusted and see metadata
  (who looked up whom, claim links). A privacy-maximizing user can skip email
  and use the copy-paste link.
- **Trusted setup:** own ceremony = soundness depends on our randomness not
  leaking. Acceptable for a demo, called out in README.
- **Pool size:** demo-scale volume means the anonymity-set argument for
  amount-unlinkability is thin. Demo copy must not claim strong anonymity.

---

## 9. Workflow & rules

Four-stage pipeline per unit of work, artifacts in `pipeline/<feature>/`:
1. `spec.md` (Plan — stop for owner OK) → 2. `changes.md` (Code) →
3. `test-results.md` (Test, paste real output) → 4. `review.md` (Review + security checklist).

Hard rules: never commit secrets or toxic-waste; no silent scope creep;
security code gets called out + tested; be honest about privacy; small
reviewable commits referencing the pipeline feature; ask before heavy/crypto
deps or files >1MB. `pipeline/` is committed (paper trail), never gitignored.