# Bullet

## Problem

Sending crypto on Stellar leaves a public trail. Every transaction creates a visible `sender -> recipient` edge on-chain. Anyone watching the chain learns who paid whom, how much, and how often. This lack of payment privacy makes Stellar unsuitable for salary payments, donations, remittances, and any transfer where the sender-recipient relationship should stay confidential.

## Vision

A world where sending money on Stellar is as private as handing someone cash. Bullet is the foundation for a full shielded payment layer on Stellar, starting with unlinkable fixed-denomination notes today and evolving toward encrypted balances with Pedersen commitments and range proofs. The long-term goal is private, compliant payments at scale, with selective disclosure so users can prove payments to auditors without making them public.

## Purpose

We built Bullet because privacy is a prerequisite for real financial inclusion. Workers sending money home, individuals receiving donations, and businesses paying contractors all deserve payment privacy. Stellar has the speed and cost structure for global payments but lacks privacy infrastructure. Bullet fills that gap using zero-knowledge proofs that are verified directly on-chain using Soroban's native BLS12-381 host functions.

## Target Users

- **Individuals** sending private payments to friends, family, or contacts via X handle or email, without exposing the sender-recipient relationship on-chain.
- **Freelancers and contractors** receiving payments where the payer-payee link should not be publicly visible on a block explorer.
- **Remittance senders** who want to send stablecoins (USDC/USDT) or XLM to recipients identified by social handle rather than wallet address, with no public trace connecting the two parties.

## Features

- **ZK-private claims** -- Groth16 proofs verified on-chain via Soroban's native BLS12-381 host functions. Nothing on-chain connects a deposit to its claim.
- **Social-handle addressing** -- Send to an X handle or email. The resolver maps handles to recipient keys. No wallet address exchange needed.
- **Multi-token support** -- USDC, XLM, and USDT. Token ID is bound in the ZK circuit to prevent cross-token drains.
- **Browser-side proving** -- The secret never leaves the browser. snarkjs generates Groth16 proofs in-browser via WASM in ~15-30 seconds.
- **Private inbox** -- Sender-authored encrypted notes (X25519 ECDH) let recipients discover claimable payments without any server seeing the plaintext.
- **Invite flow** -- Send to unregistered users via claim link. Custody keypair handles the claim, then forwards tokens to the recipient's real wallet.
- **Nullifier-based double-spend protection** -- Each note can only be claimed once. The contract stores every nullifier permanently.

## Tech Stack

- **Frontend:** Next.js 15, Tailwind CSS 4, Freighter wallet integration
- **Backend:** Node.js, Express, TypeScript, Supabase (Postgres + Auth)
- **Blockchain:** Stellar Soroban (Rust), native BLS12-381 host functions, Stellar SDK v16
- **ZK:** Circom 2.2.3, snarkjs 0.7.5, Groth16 over BLS12-381, depth-20 Poseidon Merkle tree
- **Auth:** Supabase Auth (Google + X OAuth), cookie sessions via `@supabase/ssr`

## How to Run Locally

```bash
git clone https://github.com/mdla03/bullet.git
cd bullet
cp .env.example .env    # fill in values
pnpm install
pnpm dev                # starts backend + frontend
```

Circuit regeneration (only needed if you change `circuits/claim.circom`):

```bash
pnpm build:circuits     # circom -> r1cs -> Groth16 setup -> vk -> fixture
```

Requirements: Node 20+, pnpm 9. Rust + Soroban toolchain for contracts.

## Deployment

### Testnet

- **Contract Address:** [`CCHHGCD33G5STIXEQGYK3IW3FOVJ7YTY4QKDWPMVHBRGIXDIV5OQQYSW`](https://stellar.expert/explorer/testnet/contract/CCHHGCD33G5STIXEQGYK3IW3FOVJ7YTY4QKDWPMVHBRGIXDIV5OQQYSW)
  Deployed 2026-09-14, wasm `5c2313b1…`. Carries the shielded pool and both
  verifying keys. Supersedes `CB5HPNJO…` and `CC2RTZTQ…`, which are abandoned
  contracts: any claim link older than that deploy points at stranded funds.
- **Registered tokens**, read from the contract's instance storage on
  2026-10-05, not from a deploy log:

  | `token_id` | Asset | SAC |
  | --- | --- | --- |
  | 0 | USDC | [`CBIELTK6…`](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |
  | 1 | XLM (native) | [`CDLZFC3S…`](https://stellar.expert/explorer/testnet/contract/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC) |
  | 2 | USDT | [`CBL6KD2L…`](https://stellar.expert/explorer/testnet/contract/CBL6KD2LFMLAUKFFWNNXWOXFN73GAXLEA4WMJRLQ5L76DMYTM3KWQVJN) |

  These match `*_SAC_ID` in `.env`, so the asset the app offers is the asset
  the contract accepts. `DEPLOY.md`'s 2026-09-14 entry describes slot 0 as
  native XLM; that was true at deploy and is not true now.
- **Verifying keys:** claim key 8 IC entries (7 public inputs), pool join-split
  key 9 IC entries (8 public inputs). Both installed and read back on-chain.
- **Frontend:** Vercel
- **Backend:** Railway

![Stellar Expert Testnet](./screenshots/testnet.png)

### How each piece ships

A push to master runs `.github/workflows/ci.yml`, and both hosted services
hang off that one workflow run.

| Piece | Trigger | Gate |
| --- | --- | --- |
| Frontend (Vercel) | `deploy-frontend` job in CI | `needs` all three test jobs |
| Backend (Railway) | Railway's GitHub integration | Railway "Wait for CI" |
| Contract (Soroban) | manual, `DEPLOY.md` | deliberately not automated |

Railway's **Wait for CI** lives on the repo trigger, not in this repo, so a
fresh Railway service does not have it. Without it Railway starts building the
moment the push lands and ignores the test result entirely. It is on for
`master` as of 2026-10-05.

In the dashboard it is under Settings → **Source**, next to the repo and
branch, not under Deploy. It is also settable through the API, where it is
called `checkSuites` rather than Wait for CI, which is worth knowing because
searching the schema for the dashboard's name finds nothing:

```sh
# read the current state
railway api 'query($id: String!){ service(id: $id){ repoTriggers{ edges{
  node{ id branch repository checkSuites } } } } }' --variables '{"id":"<service id>"}'

# turn it on
railway api 'mutation($id: String!, $input: DeploymentTriggerUpdateInput!){
  deploymentTriggerUpdate(id: $id, input: $input){ branch checkSuites } }' \
  --variables '{"id":"<trigger id>","input":{"checkSuites":true}}'
```

Note the id in the mutation is the **trigger** id from the first query, not the
service id.

Railway waits on the whole workflow run rather than on single jobs, so a failed
frontend deploy also holds back the backend. That is the intended trade, the
two are one release, but it means a Vercel outage or an expired token stalls
the backend. `continue-on-error: true` on `deploy-frontend` decouples them.
Railway also stops waiting after two hours, and treats a cancelled run as
blocking only when no other run on that commit succeeded.

Contract deploys stay manual. The pool holds funds and a bad verifying key is
not a rollback, it is stranded notes.

### Railway service settings

Two settings live on the Railway service rather than in this repo, so a
rebuilt or recreated service loses both silently. Neither has a file to
restore from, which is the reason they are written down here.

| Setting | Value | What breaks without it |
| --- | --- | --- |
| `checkSuites` (Wait for CI) | `true` on the `master` trigger | Railway builds on push and ignores the test result |
| `healthcheckPath` | `/health` | traffic shifts to the new deployment before it is known to work |

`/health` is deliberately dependency-free: it returns `{"ok":true}` without
touching Supabase or the RPC, so a database blip cannot fail a deploy. The
diagnostic fields behind it are gated on `HEALTH_DEBUG=1`. Point the
healthcheck at anything heavier and an outage in a dependency becomes a failed
deploy.

Both are readable and settable through the API. The service and environment
ids come from `railway status`:

```sh
# read both
railway api 'query($id: String!, $eid: String!){
  serviceInstance(serviceId: $id, environmentId: $eid){
    healthcheckPath healthcheckTimeout } }' \
  --variables '{"id":"<service id>","eid":"<environment id>"}'

# set the healthcheck
railway api 'mutation($eid: String!, $sid: String!, $input: ServiceInstanceUpdateInput!){
  serviceInstanceUpdate(environmentId: $eid, serviceId: $sid, input: $input) }' \
  --variables '{"eid":"<environment id>","sid":"<service id>",
                "input":{"healthcheckPath":"/health"}}'
```

With the healthcheck set, a backend deploy that boots and then fails now fails
the deploy and leaves the old instance serving, rather than taking traffic. The
consequence worth remembering: a stuck deploy is a reason to check `/health`,
not only the build log.

### Testing a change before it is production

Each surface gives you a different amount of safety, and the differences
matter most on the money path.

| Surface | What a PR gets you | Gap |
| --- | --- | --- |
| Frontend | a real Vercel preview deployment per PR | cannot exercise deposit or claim, see below |
| Backend | an ephemeral Railway environment per PR | its URL is not knowable at Vercel build time |
| Contract | nothing automatic | testnet is the sandbox, deploy a fresh contract per `DEPLOY.md` |

Railway PR environments are on (`prDeploys: true` on the project). Each pull
request gets its own backend with its own URL, torn down when the PR closes.
`botPrEnvironments` is deliberately left `false`, so a dependency-bump PR from
a bot does not spin up a backend.

```sh
railway api 'mutation($id: String!, $input: ProjectUpdateInput!){
  projectUpdate(id: $id, input: $input){ prDeploys botPrEnvironments } }' \
  --variables '{"id":"<project id>","input":{"prDeploys":true}}'
```

**Two Vercel env facts that cost an hour to establish, so they are written
down rather than rediscovered.**

`NEXT_PUBLIC_CONTRACT_ID` is scoped to Production only. A preview build has no
contract id, so the deposit and claim paths cannot be tested on a preview at
all. That is the single biggest hole in preview testing, because it is exactly
the code that moves funds. Fixing it means scoping a contract id to Preview,
and it should be a *different* testnet contract: pointing Preview at the same
contract as Production means preview testing writes into the pool the demo
links resolve against.

Vercel environment variables marked **Sensitive are write-only**. They cannot
be read back through `vercel env pull`, the API, or the dashboard. Reading one
out of a preview bundle does not work either, even though `NEXT_PUBLIC_*` is
inlined at build time, because preview deployments sit behind Vercel's
deployment protection and return an auth page to an anonymous fetch. So
`NEXT_PUBLIC_RESOLVER_URL` is known to be *set* for Preview and its value is
not recoverable. If you need to know where Preview points, overwrite it with a
value you choose rather than trying to discover the current one:

```sh
vercel env rm NEXT_PUBLIC_RESOLVER_URL preview
vercel env add NEXT_PUBLIC_RESOLVER_URL preview
```

`NEXT_PUBLIC_SUPABASE_URL` and the anon key are scoped to Preview *and*
Production. Unless they hold different values, which Sensitive prevents
confirming, testing on a preview writes into production data. A separate
Supabase project for Preview is the fix, and it is the largest of these three
to carry out.

### Branch protection

`master` is protected, and the settings are checked in at
`.github/branch-protection.json` so they can be restored rather than
remembered. Changes must go through a pull request, the three test jobs must
pass, and force pushes and branch deletion are blocked. No approving review is
required: the point is to keep CI in the path, not to add a human gate, so
`gh pr merge --auto` still merges a collaborator's PR unattended once it is
green.

`deploy frontend` is deliberately **not** a required check. It only runs on
push to master, so it never reports on a pull request, and requiring it would
leave every PR waiting forever.

`strict` is off, so a PR does not have to be rebased onto a moving master. Two
PRs that are green separately can therefore land broken together. At this size
the master run catches it and Railway's Wait for CI stops the bad backend
deploy. A merge queue is the real fix if that ever actually bites.

`enforce_admins` is on, which means there is no bypass for anyone, including
the repo owner. The local `pre-commit` hook is not a substitute: hooks are not
installed by cloning, so a fresh clone has no client-side guard at all and the
server-side rule is the only thing holding. To land an emergency fix, lift
protection and put it back:

```sh
gh api -X DELETE repos/mdla03/bullet/branches/master/protection
# ... push the fix ...
gh api -X PUT repos/mdla03/bullet/branches/master/protection \
  --input .github/branch-protection.json
```

Setting up CI deploys on a new clone or a new Vercel project needs one secret:

```sh
pbpaste | gh secret set VERCEL_TOKEN -R mdla03/bullet
```

Create the token at vercel.com/account/tokens, scoped to the team. Pipe the
value in rather than typing it: `gh secret set <value>` reads its argument as
the secret's *name*, so passing the token there both leaves it in your shell
history and stores a uselessly named, empty secret. With no TTY there is no
masked prompt either, and `gh secret set NAME` on its own reads empty stdin and
silently stores an empty string. An empty secret is not distinguishable from a
correct one in the secret list: the workflow log prints `VERCEL_TOKEN: ***`
when it is populated and blank when it is empty, which is the only way to tell.

The org and project ids are in the workflow already. They are not secrets, and
`.vercel/` is gitignored so the CLI cannot read them from a CI checkout.

### Mainnet

Not deployed. Testnet only. Own (non-MPC) trusted setup. Not audited.

## Demo

- Live App: https://sendbullet.xyz
- Demo Video: https://drive.google.com/file/d/12_d1DzgBn8U-fFspGnOv7UIbnBoLdGGI/view?usp=sharing
- Pitch Deck: https://canva.link/r7v03xtursupg3u

## Architecture

See `architecture_diagram.svg` for the full system diagram and `bullet_zk_architecture.pdf` for detailed technical documentation.

### How the ZK proof works

Bullet's zero-knowledge proof is load-bearing. Without it, the contract has no way to authorize a claim without revealing which deposit is being claimed.

The Groth16 circuit (`circuits/claim.circom`) proves:

1. **Merkle membership** -- `Poseidon(secret, recipientDigest, amount, tokenId)` hashes up through a depth-20 Poseidon path to a known root.
2. **Nullifier derivation** -- `nullifier = Poseidon(secret)`, domain-separated from the commitment (arity-1 vs arity-4).
3. **Value binding** -- `amount` and `tokenId` are inside the commitment, so a deposit of token A cannot be claimed as token B, and the claimed amount must match.

Five public inputs `[root, nullifier, recipientDigest, amount, tokenId]` are verified on-chain. The secret and Merkle path stay private. Verification uses Soroban's native `bls12_381` pairing_check at ~70% of the per-tx CPU budget.

### Honest privacy limits

- **Fixed denominations, not encrypted balances.** Amounts are standardized (1, 10, 50, 100 USDC), not hidden. Privacy comes from every payment looking the same size. Encrypted balances are future work.
- **Anonymity scales with pool size.** At demo scale the set is small.
- **Merkle root posted by a relayer.** On-chain Poseidon insertion exceeds the per-tx budget, so the tree is built off-chain and an admin posts roots. Decentralizing this is future work.
- **Trusted setup is single-contributor.** Production path is an MPC ceremony.
- **Delivery channels can be non-private.** Claim links and email delivery are trusted at the sender's discretion. On-chain unlinkability holds regardless.

## Repo layout

```
bullet/
├── SPEC.md              full spec, binding P0 scope
├── contracts/            Cargo workspace: zeekpay (main), verifier (Groth16)
├── circuits/             Circom source, build artifacts, scripts
├── backend/              resolver + indexer + Merkle tree + Supabase store
├── frontend/             Next.js app
├── shared/               shared TS types
└── scripts/              deploy + e2e demo scripts
```

## Team

| Name                     | Role             | GitHub          |
|--------------------------|------------------|-----------------|
| Mark Daniels Aquino      | Full Stack + ZK  | @mdla03         |
| Clarence Kyle Pagunsan   | Full Stack + ZK  | @laughable-9    |
| Elfritz Angelo Peralta   | Product Manager  | @elfrtz         |

## License

MIT
