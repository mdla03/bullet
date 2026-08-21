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
