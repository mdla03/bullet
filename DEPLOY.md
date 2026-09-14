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

**Config updated**

- `.env`: `ZEEKPAY_CONTRACT_ID`, `NEXT_PUBLIC_CONTRACT_ID`, and
  `ZEEKPAY_ADMIN_KEY`, which is now the `zeekpay-bench` secret.
- `frontend/.env.local`: `NEXT_PUBLIC_CONTRACT_ID`.

**What remains**

- **Vercel is not updated.** `NEXT_PUBLIC_CONTRACT_ID` on the Vercel project
  still points at the old contract, so the deployed frontend talks to an
  abandoned address until someone sets it and redeploys. Deliberately left
  alone here.
- **The old contract `CB5HPN...` is abandoned, not paused.** Phase 2's freeze
  never ran against it, because this deploy started from a fresh identity with
  no admin rights on it. Anyone holding an old claim link still points there
  and their funds are stranded. On testnet that is acceptable, but it is a
  real consequence, not a formality.
- **Only token slot 0 is registered.** No `add_token` call was made, so slots
  1 and 2 are empty and any `transact` with a non-zero `token_id` returns
  `UnknownToken`.
- **No deposit-to-claim cycle through the app yet.** Phase 6's smoke test and
  a claim-path proof against the current `claim.zkey` are still outstanding.
  This session exercised the pool path only, so `set_vk`'s 7-input claim key
  is installed but unproven on-chain.
- Only the one `post_root` has run, carrying the fixture's root. The indexer
  has not posted a root covering the two note commitments this deploy emitted
  at tree indices 0 and 1, so those outputs are not yet spendable.

**CLI note.** The built-in `testnet` network alias in stellar CLI 28.0.0 fails
on this machine with "rpc-url is used but network passphrase is missing", and
`stellar network add testnet` fails the same way. Every command above was run
with explicit `--rpc-url https://soroban-testnet.stellar.org` and
`--network-passphrase "Test SDF Network ; September 2015"` instead. The
`wasm32v1-none` rustup target was also missing and had to be installed before
`stellar contract build` would link.

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
