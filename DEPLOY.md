# Testnet deploy runbook

Deploying the contract that carries the amount-truncation fix, the shielded
pool, and the `upgrade` entry point.

**Testnet only.** No real funds. Nothing here is approved for mainnet: see the
blockers at the bottom.

## Read this first

**This deployment cannot be an upgrade.** The currently deployed contract has
no `upgrade` function, so this is a fresh contract at a new address and a full
migration. Every deployment after this one is an in-place upgrade that keeps
the address and all state, which is the whole point of adding it now.

The pool is folded into this deployment on purpose. The migration cost is paid
once either way, and `transact` plus `set_pool_vk` are already in the wasm.

**Funds and notes in the old contract are stranded.** Anyone holding an old
claim link is pointing at a contract this migration abandons. On testnet with
a handful of test users that is acceptable, but it is a real consequence, not
a formality.

## Phase 1: pre-flight

Confirm the signing identity and note what the old contract holds:

```sh
stellar keys address zeekpay-bench
```

Record from the old contract, because missing any of it produces a confusing
failure later rather than an obvious one:

- Registered token ids. `0` is USDC via `initialize`. `1` is XLM. Check whether
  `2` exists for USDT. A missing one surfaces as `UnknownToken`.
- The current Merkle root from the indexer. Missing this surfaces as
  `UnknownRoot` on every claim.

## Phase 2: freeze the old contract

Do this **before** deploying, so a deposit cannot land in a contract that is
about to be abandoned.

```sh
stellar contract invoke --id $OLD_CONTRACT_ID --source zeekpay-bench \
  --network testnet -- set_paused --paused true
```

## Phase 3: build, upload, deploy

```sh
cd contracts && stellar contract build && cd ..

stellar contract upload \
  --wasm contracts/target/wasm32v1-none/release/zeekpay.wasm \
  --source zeekpay-bench --network testnet
# note the wasm hash

stellar contract deploy --wasm-hash <hash> \
  --source zeekpay-bench --network testnet
# note the NEW contract id
```

## Phase 4: initialize and configure

```sh
export NEW=<new contract id>

stellar contract invoke --id $NEW --source zeekpay-bench --network testnet \
  -- initialize --admin <G...> --usdc_sac <USDC SAC id>

stellar contract invoke --id $NEW --source zeekpay-bench --network testnet \
  -- add_token --token_id 1 --sac_address <XLM SAC id>
# repeat for token id 2 if USDT was registered on the old contract
```

### Verifying keys

Set `ZEEKPAY_CONTRACT_ID` in `.env` to the new id first, since the script reads
it from there, then:

```sh
node scripts/set_vk.mjs         # claim circuit,  6 IC entries
node scripts/set_vk.mjs pool    # join-split,     9 IC entries
```

The script refuses to run if the IC count does not match the function, which
is the cheap guard against crossing the two keys.

**Use the 5-public-input claim key, which is what `groth16_soroban.json`
holds.** Do not substitute the 6-input `claim_vk.json` from the D1
amount-commitment work. `derive_public_inputs` still pushes 5 `Fr`, so a
6-input key makes every claim fail with `InvalidProof`. Shipping that circuit
is a coordinated change across contract, circuit, `set_vk` and frontend, and it
is described in `pipeline/circom-circuit/changes.md`.

### Post the current root

```sh
stellar contract invoke --id $NEW --source zeekpay-bench --network testnet \
  -- post_root --root <hex root from the indexer>
```

## Phase 5: wire the config

- `.env`: `ZEEKPAY_CONTRACT_ID` for the resolver and backend.
- `.env.local` and Vercel: `NEXT_PUBLIC_CONTRACT_ID` for the frontend.
- Redeploy the frontend so the new value is baked in.

**Leave `frontend/public/circuits/claim.{wasm,zkey}` alone.** They are the
5-input build and must stay matched to the claim key set above.

## Phase 6: verify

```sh
stellar contract invoke --id $NEW --source zeekpay-bench --network testnet \
  -- is_known_root --root <hex root>     # expect true
```

Then a real deposit-to-claim cycle through the app, and a `transact` call
against the pool.

## Phase 7: every deployment after this one

```sh
stellar contract upload --wasm contracts/target/wasm32v1-none/release/zeekpay.wasm \
  --source zeekpay-bench --network testnet
stellar contract invoke --id $CONTRACT_ID --source zeekpay-bench --network testnet \
  -- upgrade --new_wasm_hash <hash>
```

Same address, all state intact, no config churn, nothing stranded.

This is also the first real exercise of the `upgrade` admin gate. It is not
unit-testable in the native test environment, because a bogus wasm hash traps
inside `update_current_contract_wasm` whether or not the gate is present. See
the note above `upgrade_before_init_fails` in `contracts/zeekpay/src/test.rs`.

## 2026-09-14: 7-input claim key

The claim circuit moved from 5 public inputs to 7 (Pedersen amount
commitment, one curve point split across two field elements). Contract-side
change is described in `pipeline/circom-circuit/changes.md`, 2026-09-14
entry. This supersedes the "5-input claim key, 6 IC entries" note in Phase
4's Verifying keys subsection above: the claim key is now 7-input, 8 IC
entries. The join-split key is unchanged at 8-input, 9 IC entries.

**Pre-flight, checked 2026-09-14:**

- `stellar --version` was not found on this machine. Install it before
  running any command below that invokes the CLI directly; `scripts/set_vk.mjs`
  itself only needs the `@stellar/stellar-sdk` npm package, not the CLI.
- `stellar keys address zeekpay-bench` could not be checked for the same
  reason. Confirm it resolves to the admin key in `.env`
  (`ZEEKPAY_ADMIN_KEY`) before running any command that signs and sends.
- `circuits/build/groth16_soroban.json` was still the stale 5-input
  conversion (6 IC entries) before this change; regenerated below.
- `circuits/build/joinsplit_soroban.json` is already correct at 9 IC entries
  and needs no regeneration.
- A `set_vk --dry-run` simulation against the contract id currently in
  `.env` (`ZEEKPAY_CONTRACT_ID`) found that contract has no `set_pool_vk`
  function at all, meaning it predates the pool/upgrade migration in Phases
  1-6 above. That migration (fresh deploy, not an upgrade) has to run before
  either `set_vk` command below is meaningful. Re-run the dry run against
  whatever contract id Phase 4 produces before trusting these commands
  against it blindly.

**Commands, in order, from the repo root:**

```sh
# 1. Regenerate the claim key JSON (fixture is already pinned, JSON only)
node circuits/scripts/convert-to-soroban.mjs --out circuits/build/groth16_soroban.json
# expect: ic: 8 pubs: 7

# 2. Build the wasm
cd contracts && stellar contract build && cd ..

# 3. Deploy: this contract has no `upgrade` yet, so it is a fresh deploy,
#    not Phase 7's upgrade path. Follow Phases 3-4 above in full (upload,
#    deploy, initialize, add_token, post_root) using the freshly built wasm.
#    A later deploy that only rotates this key, against a contract that
#    already has `upgrade`, uses Phase 7 instead of this step.

# 4. Set the claim key (8 IC entries, derived from the JSON, checked against
#    the contract's expectation)
node scripts/set_vk.mjs

# 5. Set the pool key (unchanged, 9 IC entries)
node scripts/set_vk.mjs pool

# 6. Smoke-test: a real deposit-to-claim cycle through the app (Phase 6),
#    using a proof generated against the current claim.zkey. Confirm the
#    claim event carries (nullifier, amount_commitment) per changes.md.
```

Add `--dry-run` to either `set_vk.mjs` command to simulate only (no sign, no
send) and inspect the resource footprint and any error first.

**Failing closed.** Until step 4 runs, the deployed contract's stored claim
key still has 6 IC entries while `derive_public_inputs` on the new wasm
pushes 7 `Fr`. `verifier::verify` checks `vk.ic.len() != pubs.len() + 1`
before any pairing math, so every claim against the new wasm returns
`InvalidProof` until `set_vk` lands. That is a real outage window between
step 3 and step 4, not a misconfiguration risk: it fails closed rather than
accepting a mismatched proof.

## 2026-09-14: testnet deploy and D2 evidence

Fresh contract, both verifying keys installed, and the SOW D2 pair of pool
deposits (one accepted, one rejected) landed on testnet. **Testnet only.**

**Contract**

- Contract ID: `CCHHGCD33G5STIXEQGYK3IW3FOVJ7YTY4QKDWPMVHBRGIXDIV5OQQYSW`
  - https://stellar.expert/explorer/testnet/contract/CCHHGCD33G5STIXEQGYK3IW3FOVJ7YTY4QKDWPMVHBRGIXDIV5OQQYSW
- Wasm hash: `5c2313b15ac91997c60b23ad12f424bdd09983ece892d6e7011d0d6ea627c621`
- Wasm: `contracts/target/wasm32v1-none/release/zeekpay.wasm`, 15030 bytes,
  built with stellar CLI 28.0.0.

**Identities** (public addresses only; secrets live in the CLI keystore and
the gitignored `.env`)

- `zeekpay-bench`, admin and root poster:
  `GCTGLSNOSCHDYXEJ73FQMFW6W4EZQMC2MZWEZR66K24KF6MMW3QAGAMK`
- `bullet-depositor`, the depositor and the source of both `transact` calls:
  `GAOMAG7I36AZBKHCLWNNWOCQ52P7HJAMA5LPMVVOCYIL2SXZPDSVUAPJ`

Both funded by friendbot at 10,000 XLM. `zeekpay-bench` doubles as the
withdrawal recipient, so the 3-stroop `public_withdraw` leg has somewhere to
land without creating a third identity.

**Token choice, and it is a testnet-only one.** `initialize` was called with
`usdc_sac` set to the native XLM asset contract on testnet,
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`, not a USDC SAC.
Two reasons. The join-split fixture's `tokenId` public input is `0`, which is
the slot `initialize` writes, so the proof only verifies against whatever is
registered there. And native XLM needs no trustline, so a freshly funded
depositor can transact immediately. On mainnet slot 0 is USDC and this
substitution must not carry over.

**Superseded on 2026-09-17.** It did carry over, into the app rather than into
mainnet, and it broke both send paths. See "2026-09-17: token registry fix"
below. Slot 0 is now the real testnet USDC SAC.

**Transactions, in the order they were sent**

| Step | Hash | Result |
| --- | --- | --- |
| Upload wasm | [`b5cf411a...`](https://stellar.expert/explorer/testnet/tx/b5cf411a5a3c7e2dfc19c67853330b1c268dfc4fb04cba819db67c87035fb732) | success |
| Deploy | [`f2ff2879...`](https://stellar.expert/explorer/testnet/tx/f2ff2879c90a2d38016d2d78d041a347b14c5bc283a093bfdadfd182c8c23fac) | success |
| `initialize` | [`8b091e8b...`](https://stellar.expert/explorer/testnet/tx/8b091e8b78343b7e9dfcda40d09a64e1faac42848eb59c6484c65af995f803f2) | success |
| `set_vk` (claim, 8 IC) | [`92bbe9cf...`](https://stellar.expert/explorer/testnet/tx/92bbe9cfe76bbe4f8056502ca64de754eadf6e137d737e41327c212708b09591) | success |
| `set_pool_vk` (join-split, 9 IC) | [`f2246eed...`](https://stellar.expert/explorer/testnet/tx/f2246eed7c4304ee71cd6d66022de27c8c94872135b55ad5c78ef816952b04fa) | success |
| `post_root` (fixture root) | [`a8e14c2f...`](https://stellar.expert/explorer/testnet/tx/a8e14c2faeb704cc59bafeb406a1c97ac48d68506beebcf16c7afb642d8e6512) | success |
| **Rejected** `transact`, `public_deposit` 8 | [`32ff99df...`](https://stellar.expert/explorer/testnet/tx/32ff99df917a5a2a8f594d9e5da3af673b6fee03ea78396dae54db7fbce5cf86) | **txFailed**, contract error 7 (`InvalidProof`) |
| **Accepted** `transact`, `public_deposit` 7 | [`ea80ad5b...`](https://stellar.expert/explorer/testnet/tx/ea80ad5bd2b469599a98bfefa94e9222e5da48fe82e71945fe1cafe3704aa683) | success |

Full hashes:

```
upload        b5cf411a5a3c7e2dfc19c67853330b1c268dfc4fb04cba819db67c87035fb732
deploy        f2ff2879c90a2d38016d2d78d041a347b14c5bc283a093bfdadfd182c8c23fac
initialize    8b091e8b78343b7e9dfcda40d09a64e1faac42848eb59c6484c65af995f803f2
set_vk        92bbe9cfe76bbe4f8056502ca64de754eadf6e137d737e41327c212708b09591
set_pool_vk   f2246eed7c4304ee71cd6d66022de27c8c94872135b55ad5c78ef816952b04fa
post_root     a8e14c2faeb704cc59bafeb406a1c97ac48d68506beebcf16c7afb642d8e6512
transact 8    32ff99df917a5a2a8f594d9e5da3af673b6fee03ea78396dae54db7fbce5cf86
transact 7    ea80ad5bd2b469599a98bfefa94e9222e5da48fe82e71945fe1cafe3704aa683
```

**D2 evidence, the on-chain restatement of `test_pool_d2.rs`**

Both calls use the same real join-split proof from
`contracts/zeekpay/src/joinsplit_fixture.rs`, the same root, the same
nullifiers and the same commitments. The only difference is the claimed
`public_deposit`: the proof attests to 7, and the rejected call claims 8.
`derive_pool_public_inputs` feeds the claimed amount into the verifier, so the
verified statement stops matching what the proof attests to.

The rejected call went first on purpose. Nullifiers are single-use, so once
the honest call records them no second `transact` on this fixture is possible.

The CLI cannot send the rejected call: simulation fails by design, and
`stellar contract invoke` refuses to submit a transaction that does not
simulate. It was submitted with a small script instead (kept out of the repo,
in the session scratchpad): simulate the honest call for its footprint and
resources, reuse that footprint for the tampered call, which is a superset
since the tampered call returns before the nullifier writes and the token
legs, sign with `bullet-depositor`, `sendTransaction`, then poll until
included. Resources were padded 1.5x on instructions and 3x on the resource
fee so the failure is the guard firing and not an exhausted budget.

Confirmed on Stellar Expert: `32ff99df...` decodes as `txFailed`, and its
diagnostic events read `fn_call transact` then `error Error(Contract, #7)`.
Nothing else in that transaction ran.

**Balances, in stroops of native XLM via the SAC's `balance`**

| Account | Before | After | Delta |
| --- | --- | --- | --- |
| `bullet-depositor` | 100000000000 | 99999069530 | -930470 |
| `zeekpay-bench` (recipient) | 99989625434 | 99989625437 | +3 |
| contract | 0 | 4 | +4 |

The contract moved by exactly `public_deposit - public_withdraw`, 7 - 3 = 4,
and the recipient by exactly `public_withdraw`, 3. The depositor's -930470 is
the 7-stroop deposit plus 930463 stroops of network fees across both
transactions (93398 on the failed one, 837065 on the accepted one). 7 + 930463
= 930470, so the accounting closes. The deposit leg itself is exact in the
transfer event on `ea80ad5b...`: 7 from `bullet-depositor` to the contract.

Both fixture nullifiers read `is_nullifier_used = true` after the accepted
call, and read `false` in between the rejected call and the accepted one, so
the rejected call wrote no state.

**Config updated, on the deployer's machine only**

Both files below are gitignored, so this records what was changed locally by
whoever ran this deploy. A clone elsewhere still points at the old contract
until someone repeats these edits there, and the `zeekpay-bench` identity is
in that machine's CLI keystore, not in the repo. Another machine's
`zeekpay-bench` is a different keypair with the same name: the admin of this
contract is specifically `GCTGLSNOSCHDYXEJ73FQMFW6W4EZQMC2MZWEZR66K24KF6MMW3QAGAMK`,
so check the address before assuming a local identity is the right one.

- `.env`: `ZEEKPAY_CONTRACT_ID`, `NEXT_PUBLIC_CONTRACT_ID`, and
  `ZEEKPAY_ADMIN_KEY`, which is now the `zeekpay-bench` secret.
- `frontend/.env.local`: `NEXT_PUBLIC_CONTRACT_ID`.

**What remains**

- **Vercel is not updated.** `NEXT_PUBLIC_CONTRACT_ID` on the Vercel project
  still points at the old contract, so the deployed frontend talks to an
  abandoned address until someone sets it and redeploys. Deliberately left
  alone here. *Resolved since: Vercel production carries the new contract id
  and all three SAC ids. Verified 2026-09-17 against the deployed bundle.*
- **The old contract `CB5HPN...` is abandoned, not paused.** Phase 2's freeze
  never ran against it, because this deploy started from a fresh identity with
  no admin rights on it. Anyone holding an old claim link still points there
  and their funds are stranded. On testnet that is acceptable, but it is a
  real consequence, not a formality.
- **Only token slot 0 is registered.** No `add_token` call was made, so slots
  1 and 2 are empty and any `transact` with a non-zero `token_id` returns
  `UnknownToken`. *Resolved 2026-09-17, after it reached the app. See the
  section below.*
- **No deposit-to-claim cycle through the app yet.** Phase 6's smoke test and
  a claim-path proof against the current `claim.zkey` are still outstanding.
  This session exercised the pool path only, so `set_vk`'s 7-input claim key
  is installed but unproven on-chain.
- Only the one `post_root` has run, carrying the fixture's root. The indexer
  has not posted a root covering the two note commitments this deploy emitted
  at tree indices 0 and 1, so those outputs are not yet spendable.

**CLI note, resolved.** The built-in `testnet` network alias failed with
"rpc-url is used but network passphrase is missing", and `stellar network add
testnet` failed the same way, so every command above was run with explicit
`--rpc-url https://soroban-testnet.stellar.org` and `--network-passphrase
"Test SDF Network ; September 2015"` instead.

That workaround is no longer needed. The cause was not the CLI version and not
the machine: the stellar CLI auto-loads `.env` from the working directory, and
the `SOROBAN_RPC_URL` key that used to live there was read as an `--rpc-url`
with no matching passphrase, so the alias broke for every command run inside
the repo. Reproduced identically on CLI 27.0.0 and 28.0.0; an empty `.env`, a
renamed key, or running from outside the repo all work. Adding
`NETWORK_PASSPHRASE` or `STELLAR_NETWORK_PASSPHRASE` to `.env` does **not**
fix it; exporting `STELLAR_NETWORK_PASSPHRASE` in the shell does.

The key is now `BULLET_RPC_URL` (see `.env.example`), so `--network testnet`
works from the repo root. If the error comes back, look for a `SOROBAN_RPC_URL`
key that has crept back into `.env`. The
`wasm32v1-none` rustup target was also missing and had to be installed before
`stellar contract build` would link.

## 2026-09-17: token registry fix, and a full database reset

The testnet-only token substitution above reached the app. Both send paths
were broken by it, in different ways, against the same contract
`CCHHGCD33G5STIXEQGYK3IW3FOVJ7YTY4QKDWPMVHBRGIXDIV5OQQYSW`.

**Symptoms**

- An XLM send failed with `Error(Contract, #11)`, `UnknownToken`. The frontend
  sends `token_id: 1` for XLM (`SendForm.tsx` `TOKENS`), and slot 1 was never
  registered.
- A USDC send succeeded but moved XLM. Slot 0 held the native XLM SAC, so
  `deposit` pulled XLM from the sender and `claim` paid XLM to the recipient,
  while every label in the UI said USDC. The contract was correct; the
  registry disagreed with the rest of the system.

Both are one cause. `initialize` wrote the native XLM SAC into slot 0 and
`add_token` was never called, so the on-chain registry never matched the
`0 = USDC, 1 = XLM, 2 = USDT` mapping that `SendForm.tsx`, `Inbox.tsx`,
`ClaimView.tsx`, `SendHistory.tsx` and `dashboard/page.tsx` all hard-code.

**Diagnosis worth repeating.** Read the contract's instance storage directly
rather than inferring config from `.env`. `stellar contract read` returns only
the instance hash, so fetch the entry over RPC and walk
`contractData().val().instance().storage()`. Every wrong guess in this session
came from trusting a local `.env` that no deployed component reads.

**Fix.** Three `add_token` calls, signed by the contract admin
`GCTGLSNOSCHDYXEJ73FQMFW6W4EZQMC2MZWEZR66K24KF6MMW3QAGAMK`. `add_token`
overwrites, so slot 0 did not need clearing first.

| Call | Hash | Result |
| --- | --- | --- |
| `add_token 0` USDC | [`1dc5c597...`](https://stellar.expert/explorer/testnet/tx/1dc5c5979875af85ff5374cf5b318e329b59b6247583aae12f4f9da0358a27d1) | success |
| `add_token 1` XLM | [`e86ed078...`](https://stellar.expert/explorer/testnet/tx/e86ed078ae7db86364a3408b1dd57c3bec4d3bef42b34b342b2defb5dc36b90c) | success |
| `add_token 2` USDT | [`abf91e40...`](https://stellar.expert/explorer/testnet/tx/abf91e4012972f8966ae694ded44ed0801a3328f6098a3da70354f2a01b71a93) | success |

Registry after, read back from instance storage:

```
Token(0) => CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA  USDC:GBBD47IF...
Token(1) => CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC  native XLM
Token(2) => CBL6KD2LFMLAUKFFWNNXWOXFN73GAXLEA4WMJRLQ5L76DMYTM3KWQVJN  USDT:GAHPYWLK...
```

**Slot 0 now needs a trustline.** Every sender must hold a testnet trustline
for `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` and a
balance, or `deposit` fails inside the SAC transfer. That is the friction the
original substitution was avoiding. XLM sends still need nothing. Accepted on
purpose: the alternative is a UI that says USDC and moves XLM.

**Remapping slot 0 stranded every note already in it.** Those notes were
deposited as XLM against slot 0; their claims now try to transfer USDC the
pool does not hold. Unavoidable on any fix path, since the commitment binds
`tokenId` and the pool holds what was actually deposited.

**Database reset** (Supabase, all rows, deliberate):

```
notes            42 -> 0
activity         62 -> 0
merkle_leaves     5 -> 0
pending_invites   8 -> 0
merkle_state cursor parked at ledger 4727829
```

Two notes on that. First, `REINDEX_ON_BOOT=1` is the wrong tool for a
permanent delete: `indexer.ts` calls `store.clearAll()` and then rescans from
`START_LEDGER`, which re-inserts the same deposit events. Clearing the leaves
and parking the cursor ahead of the stranded deposits is what actually drops
them. Second, `pending_invites` held `custody_stellar_address` and
`custody_secret`, the only record of the custody keypairs for unclaimed
invites. Deleting those rows makes any balance in those accounts
unrecoverable. Testnet, and those invites were tied to the stranded notes, but
it is a real consequence and it was not flagged before the delete ran.

`merkle_leaves` was 5 while the contract's `Index` read 7. The two missing are
the `transact` join-split outputs: `indexer.ts` only handles the `deposit`
topic, so pool outputs never enter the tree. They were never claimable. The
contract's `Index` is not reset by any of this and does not need to be, since
the indexer assigns its own leaf indices from 0 and never reads it.

**Config that turned out to be correct already**, both verified rather than
assumed:

- **Vercel production.** All `NEXT_PUBLIC_*` vars are marked Sensitive, so
  `vercel env pull` returns placeholders. Read the real values out of the
  deployed bundle instead, since `NEXT_PUBLIC_*` is inlined at build time:
  fetch the route HTML, extract the `/_next/static/chunks/*.js` paths, and
  grep for `C[A-Z2-7]{55}`. Contract id and all three SAC ids were correct.
- **Railway backend.** `/health` returns only `{"ok": true}` unless
  `HEALTH_DEBUG=1`, so infer instead. The indexer cursor advances to chain
  latest every poll even with zero inserts, which proves both
  `ZEEKPAY_CONTRACT_ID` and `ZEEKPAY_ADMIN_KEY` are set (`indexer.ts` disables
  the loop otherwise). To prove the key is the *right* one, decode a recent
  `post_root`: [`5772880a...`](https://stellar.expert/explorer/testnet/tx/5772880ae16fe82fef07aca4f0583d57a0f118d69766053b85c7ac361fbe75db)
  is `post_root` on `CCHHGCD3...`, signed by `GCTGLSNO...`. Root posting was
  never broken.

**Local config was the only stale copy**, and it is gitignored, so this is
again a record of one machine:

- `.env`: `ZEEKPAY_CONTRACT_ID` and `NEXT_PUBLIC_CONTRACT_ID` moved off the
  abandoned `CB5HPN...`; added `USDT_SAC_ID`, `NEXT_PUBLIC_USDC_SAC_ID` and
  `NEXT_PUBLIC_USDT_SAC_ID`, which `invite_claim.ts` reads and which were
  absent; `ZEEKPAY_ADMIN_KEY` set to the `GCTGLSNO` secret.
- `frontend/.env.local`: `NEXT_PUBLIC_CONTRACT_ID`.

**What remains**

- **Still no deposit-to-claim cycle through the app.** Phase 6's smoke test is
  outstanding from the 2026-09-14 deploy and this session did not close it.
  Everything above is verified by reading state, not by exercising the path.
- The backend needs a restart to pick up the emptied tree, since the in-memory
  tree only hydrates at boot. Do not set `REINDEX_ON_BOOT=1` on that restart.

## 2026-10-03: cross-entry-point double-spend fix, pool VK rotated

A note could be spent once through `claim` and again through `transact`,
draining the pool. Both circuits derive the note commitment identically, but
the pool derived the nullifier as `Poseidon([secret, leafIndex])` while claim
used `Poseidon([secret])`. The contract keys both into one `DataKey::Nullifier`
space as different values, so a claim recorded one nullifier and a later
`transact` on the same note checked a different one, found it unused, and paid
out again. Every note was doublable; the ceiling was the whole pool.

Demonstrated on testnet before fixing: cycle-2's note, already claimed by
[`eef7f777`](https://stellar.expert/explorer/testnet/tx/eef7f777d04bb78084cdedc66e9305d7f0cfc3ffb361773a727f6711efddcc81),
paid out a second time through `transact` by
[`945253cf`](https://stellar.expert/explorer/testnet/tx/945253cfc6fdb11baeaed4204983d0d3e7fbeedec4405ea189ca8fef3b7ba580).
`frontend/scripts/double_spend_poc.mts` reproduces it.

**Fix.** `joinsplit.circom` now derives the nullifier as `Poseidon([secret])`,
identical to claim. One note has one nullifier whichever entry point spends it,
so the second attempt collides on the storage key and is rejected. The
`leafIndex` input and its `leafIndex === path index` constraint stay (so the
`leafindex_mismatch` vector keeps a live site), but the nullifier no longer uses
it. `claim.circom`, `claim.zkey`, the pinned `groth16_fixture.rs` and the live
claim path are untouched.

**Pool VK rotated. This supersedes `f2246eed` above as the live pool key.**

| Call | Hash | Result |
| --- | --- | --- |
| `set_pool_vk` (rebuilt join-split) | [`e67598c7...`](https://stellar.expert/explorer/testnet/tx/e67598c7c6439747f7ebf340de6e53b4e53ae6195cdeeb05d174411a4a642740) | success |

Re-running the PoC against the new key now fails with `Error(Contract, #6)`
`NullifierUsed`: the proof verifies, then the contract rejects the reused
nullifier. The legitimate pool flow (fund, hidden transfer, withdraw) still
works under the new key.

**Reproducibility gotcha.** The rotation drew a fresh (non-MPC) setup, so the
deployed `PoolVk` corresponds to ONE specific `circuits/build/joinsplit.zkey`,
which is gitignored. The matching copy ships at
`frontend/public/circuits/joinsplit.zkey` (committed, served to the browser) and
is byte-identical to the build. Rebuilding with `FORCE_SETUP=1
circuits/scripts/build-joinsplit.sh` produces a DIFFERENT key and every existing
proof stops verifying; after any such rebuild you must
`node circuits/scripts/convert-to-soroban.mjs joinsplit` (needs `FORCE_FIXTURE=1`),
`node scripts/set_vk.mjs pool`, and redeploy the frontend so the served zkey
matches. The committed `joinsplit_soroban.json` / `joinsplit_fixture.rs` pin the
deployed key's shape.

**Pool UI shipped.** `/pool` (`frontend/src/components/PoolWallet.tsx`) exposes
fund, send-privately-to-a-handle, and withdraw. Self-held notes live in
`localStorage` (`pool_wallet.ts`); notes sent to a recipient ride the existing
encrypted inbox with a `kind: "pool"` discriminator the claim inbox skips. The
library (`pool_note.ts`, `pool_tx.ts`, `pool_path.ts`, `pool_ops.ts`) was
verified end to end on testnet with a local-keypair signer; the React screen
itself is not Freighter-click-tested.

## Before mainnet, none of which is done

- **External audit.** SOW out-of-scope item 4. The balance constraint and the
  BN254-constants-under-BLS12-381 Poseidon instantiation are the two things to
  put in front of an auditor first.
- **Multi-party trusted setup.** SOW out-of-scope item 3. Both the claim and
  join-split keys come from single local contributions.
- **The `upgrade` admin key becomes a fund-control key.** Whoever holds it can
  swap in arbitrary code. Wants a timelock, a multisig, or removal of the entry
  point once the code is stable.
- **Deposits are still not bound to their commitments** on the claim path. The
  pool's balance constraint fixes this for `transact`, but `deposit`/`claim`
  remain as they were.
