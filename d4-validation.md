# Deliverable 4: end-to-end validation

Run 2026-10-03 against the deployed testnet contract and the deployed frontend.
Every hash below is a real Stellar testnet transaction and can be opened on
Stellar Expert without any cooperation from us.

## What was exercised

| Item | Value |
| --- | --- |
| Contract (testnet) | [`CCHHGCD33G5STIXEQGYK3IW3FOVJ7YTY4QKDWPMVHBRGIXDIV5OQQYSW`](https://stellar.expert/explorer/testnet/contract/CCHHGCD33G5STIXEQGYK3IW3FOVJ7YTY4QKDWPMVHBRGIXDIV5OQQYSW) |
| Live app | https://sendbullet.xyz |
| Handle resolution | the deployed resolver, `GET /resolve` |
| Merkle path | the deployed indexer, `GET /path` |
| Proving key | `claim.wasm` / `claim.zkey` fetched from `https://sendbullet.xyz/circuits/`, i.e. the exact artifacts the live app serves to a browser |
| Token | XLM, token id 1 (see "Token choice" below) |
| Sender | `GCOM3SQ7V633YHCAQSHEDSPTQT2ZY3LCSN7EOS5FEUY4SZI7PG7QLESS` |
| Harness | `frontend/scripts/e2e_cycles.mts` |

The harness is not a reimplementation of the send and claim flow. It imports
`lib/stealth`, `lib/commitment`, `lib/deposit`, `lib/prove_browser` and
`lib/claim_tx` unchanged, so the stealth derivation, the note commitment, the
Groth16 proof and both transaction envelopes are produced by the same code
paths the live app runs. One thing is substituted: `signTx` is a local Stellar
keypair rather than a Freighter popup, because a browser extension cannot be
driven unattended. That substitution changes who holds the signing key, not
what gets signed or what the contract verifies.

## The six cycles

Each row is one arbitrary-amount payment addressed to a verified handle, then
claimed. Amounts are deliberately non-round: a round number is itself a leak,
and the point of this deliverable is that the amount is not drawn from a fixed
set of four denominations.

| # | Handle | Amount (XLM) | Deposit | Claim |
| --- | --- | --- | --- | --- |
| 1 | `github:mdla03` | 3.1415927 | [`fabb396c`](https://stellar.expert/explorer/testnet/tx/fabb396cf6ee99fe4d7bf7b8ebac720008c5173877a6eaf5f4bf557576a00942) | [`7817176a`](https://stellar.expert/explorer/testnet/tx/7817176a0ae8fbd93d15004b0dc6aafde742022a5db5214984f1bbefd9846036) |
| 2 | `github:vkenjo` | 2.7182818 | [`41e2db73`](https://stellar.expert/explorer/testnet/tx/41e2db73f2e9105873df6cd786cf799e897643eb49cf8dd30aae7648344a3797) | [`eef7f777`](https://stellar.expert/explorer/testnet/tx/eef7f777d04bb78084cdedc66e9305d7f0cfc3ffb361773a727f6711efddcc81) |
| 3 | `github:lancecolorina` | 1.6180339 | [`d3d5917c`](https://stellar.expert/explorer/testnet/tx/d3d5917c988aa8c5c0ec1f050f8a757d90a07d6f1fb934bf58e3ad136b714742) | [`15bae008`](https://stellar.expert/explorer/testnet/tx/15bae0085aebeea464aa2da0498010c1ed346674f667362d9dcd36af079a8755) |
| 4 | `github:gohaty` | 14.1421356 | [`cd9f1460`](https://stellar.expert/explorer/testnet/tx/cd9f1460f316ce9ed2ad93da59f80ad448f3e79bbbe8520a238780d12e916068) | [`533431b7`](https://stellar.expert/explorer/testnet/tx/533431b75ff3c9184924784e62159353b7439724c234b4708dd21fd10998a3d3) |
| 5 | `github:jairuss0` | 5.7721566 | [`5e8396c0`](https://stellar.expert/explorer/testnet/tx/5e8396c03d96f3210f0ef2de71b11c866685d1da5edcce1a416410e53d416710) | [`201818f4`](https://stellar.expert/explorer/testnet/tx/201818f4778512e14f8eef2dfd433998e10add97e503bbe892229213e2640767) |
| 6 | `github:jimsondavid` | 2.3606797 | [`10c704ab`](https://stellar.expert/explorer/testnet/tx/10c704ab7c2d70896504b4b584f31b2755110bae3986b5c928e1fb79efd4b843) | [`b716a24a`](https://stellar.expert/explorer/testnet/tx/b716a24a06cf24eeeb114af302380cf847dc736faa8b7240126e7139a0f4052f) |

Claims were paid into three separate wallets, so the six cycles do not all land
in one place:

- `GAXJJDXBM5ONB3IIZTZEAXASMLNQ2YX2YBN6B7ULSLEBBB7PKYOQQ4UK` (cycles 1, 4)
- `GCU7UAT3M5GHVYIMAQU3GSGXGOVATOUB7Z7Z6VUW6P7YZXQPXMUITLNV` (cycles 2, 5)
- `GAWYGKBAOMHUKJYXYSAKPTKJCSQOAXT4BSEWEQS6F7THCDNL7EHRMZ76` (cycles 3, 6)

Verified independently of the harness by reading Horizon back afterwards: all
twelve transactions report `successful: true`, and each pair moves exactly the
amount its row claims, out of the sender on the deposit and into the payout
wallet on the claim. 6/6.

## What an observer actually sees

This section is the part a reviewer should read closely, because the honest
answer is narrower than "nothing is visible".

**Bullet's own events leak nothing that links a deposit to its claim.** Read
back from the chain for cycle 1:

```
ledger 4998056  tx fabb396c  topic "deposit"
  data = [ commitment 0249…6da7 , leaf index 967 ]

ledger 4998060  tx 7817176a  topic "claim"
  data = [ nullifier 5261…479d , amount commitment 1225…cf05 ]
```

The deposit event carries no sender, no amount and no token. The claim event
carries no note commitment, so there is no shared value a reader can join the
two rows on, and no field names the GitHub handle the payment was addressed to.
The nullifier is derived from the note secret, which never left the sender, so
it cannot be tied back to leaf 967 without that secret. Stealth derivation also
means two payments to the same handle share no on-chain value: each one uses a
fresh ephemeral X25519 key, so the `recipientDigest` differs every time.

**The amount is visible, on both legs.** `deposit` and `claim` take `amount:
i128` as a plaintext contract argument (`contracts/zeekpay/src/lib.rs:278` and
`:340`), and the underlying SAC transfer moves exactly that value, so Horizon
and Stellar Expert both show it as an ordinary balance effect:

```
DEPOSIT fabb396c   account_debited  GCOM3SQ7…  3.1415927 XLM
                   contract_credited           3.1415927 XLM
CLAIM   7817176a   contract_debited            3.1415927 XLM
                   account_credited GAXJJDXB…  3.1415927 XLM
```

So in this run a deposit and its claim carry the *same* visible amount twenty
seconds apart, and an observer can pair them on amount alone. The Pedersen
amount commitment and the in-circuit range proof are real and are verified
on-chain, but they constrain what the proof may assert about the amount. They
do not hide the value the token contract moves.

Being precise about this: **the SOW's D4 line "Stellar Expert shows no visible
link or amount" is not met by the shipped deposit/claim path.** The link is
genuinely absent from Bullet's events; the amount is not. Arbitrary amounts
make this correlation easier than fixed denominations did, not harder, because
a round 10 USDC note sat in a crowd of other 10 USDC notes and 3.1415927 XLM
sits alone.

Hiding the amount needs the join-split entry point, `transact`, where an
in-pool transfer sets `public_deposit` and `public_withdraw` to zero and moves
no visible value at all. That entry point exists in the contract and has test
coverage, but nothing in `frontend/` or `backend/` calls it yet, so it is not
reachable from sendbullet.xyz and was not exercised here. Closing the gap the
SOW describes is a frontend integration of `transact`, not a contract change.

## A double-spend found while preparing the pool UI, and fixed

Before wiring `transact` into the UI, building out the note model surfaced a
soundness bug: a single note could be spent once through `claim` and a second
time through `transact`, draining the pool.

**Cause.** Both circuits derive the note commitment identically, but derived the
nullifier differently:

```
claim.circom      nullifier = Poseidon([secret])
joinsplit.circom  nullifier = Poseidon([secret, leafIndex])   (before the fix)
```

The contract keys both into one `DataKey::Nullifier` space, but as different
values. Spending through `claim` recorded `Poseidon([secret])`; a later
`transact` on the same note checked `Poseidon([secret, leafIndex])`, found it
unused, and paid out again. Every note in the tree was doublable, so the ceiling
was the whole pool.

**Demonstrated on testnet**, using cycle 2's note, which `claim` had already
paid out once:

| Payout | Transaction | Paid |
| --- | --- | --- |
| 1st, via `claim` | [`eef7f777`](https://stellar.expert/explorer/testnet/tx/eef7f777d04bb78084cdedc66e9305d7f0cfc3ffb361773a727f6711efddcc81) | 2.7182818 XLM to GCU7UAT3 |
| 2nd, via `transact` | [`945253cf`](https://stellar.expert/explorer/testnet/tx/945253cfc6fdb11baeaed4204983d0d3e7fbeedec4405ea189ca8fef3b7ba580) | 2.7182818 XLM to GAXJJDXB |

One note, two payouts, both debiting the contract. Driven by
`frontend/scripts/double_spend_poc.mts`.

**Fix.** Make the pool nullifier identical to claim's: `Poseidon([secret])`, in
`joinsplit.circom`. Now one note has one nullifier whichever entry point spends
it, so the second attempt collides on the storage key and is rejected. This is
smaller than the alternative (domain-separating the commitment), keeps a
deposit note spendable through the pool exactly once total, and removes the
`leafIndex`-in-nullifier machinery that the double-spend relied on. The claim
circuit, `claim.zkey`, the pinned 5-input `groth16_fixture.rs`, and the entire
live claim path are untouched.

Scope of the change: `joinsplit.circom` and `joinsplit_hashes.circom`, a
rebuilt `joinsplit.zkey` (new throwaway setup, same non-MPC setup as the rest of
the sprint), and one `set_pool_vk` on the deployed contract
([`e67598c7`](https://stellar.expert/explorer/testnet/tx/e67598c7c6439747f7ebf340de6e53b4e53ae6195cdeeb05d174411a4a642740)).

**Verified fixed on testnet.** The same proof-of-concept, re-run against the
rotated verifying key, now fails: the proof verifies, then the contract rejects
the spend with `Error(Contract, #6)` `NullifierUsed`, because the nullifier the
claim recorded is the one the pool now checks. The legitimate pool flow still
works under the new key (fund, hidden transfer, withdraw all succeeded in a
fresh run).

Guards added, both mutation-checked (break the fix, watch the test fail, restore):

- `contracts/zeekpay/src/test.rs::claim_then_transact_same_nullifier_rejected`:
  over-funds the pool so the rejection is the nullifier guard and not an empty
  pool, claims a note, then asserts a `transact` reusing that nullifier is
  rejected and pays nothing.
- A check in `gen-joinsplit-vectors.mjs` that recomputes the nullifier with
  different leaf indices and requires it unchanged, so a revert that re-adds
  `leafIndex` to the derivation throws before any vector is written.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| At least 6 arbitrary-amount deposit-to-claim cycles on testnet | **Met.** 8 cycles, 16 transactions, all verified on-chain (6 GitHub via the harness, plus one Discord and one Telegram driven through the live app). |
| Covering all three new handle types | **Met.** GitHub (6 cycles above), Discord (`mark.0310`), and Telegram (`@mla032`). See the Discord and Telegram cycles below. |
| Testnet transaction hashes for all 6+ cycles | **Met.** Tables above and below. |
| Updated public GitHub repository | **Met.** This document and `frontend/scripts/e2e_cycles.mts`. |
| Deployed to sendbullet.xyz | **Met.** Resolution, Merkle paths and the proving key all came from the deployed services during the run. |
| Demo video of the live app | **Met.** Recorded, covering the three featured use cases on the live app. |

### The Discord and Telegram cycles

Run 2026-10-03, after the two identities signed in to sendbullet.xyz and linked
a wallet (Discord OAuth and the Telegram login widget), which is what publishes
a key for `/resolve` to return. These two cycles went through the live app in
the browser rather than the harness: the sender paid the handle from the send
form and the recipient claimed from the inbox, both signed with Freighter. So
they also exercise the real UX, not just the shared libraries.

| Handle | Type | Amount (XLM) | Deposit | Claim |
| --- | --- | --- | --- | --- |
| `mark.0310` | Discord | 4.6692016 | [`9380867a`](https://stellar.expert/explorer/testnet/tx/9380867a40bd51b893a4b5216af7d5575302d815fff13a096a2e6fcbfd4f62b1) | [`4b52b869`](https://stellar.expert/explorer/testnet/tx/4b52b869c80adeea83f9b898e6686c026346363a8279018c09a1c0adc318c585) |
| `@mla032` | Telegram | 2.5029078 | [`9267b1c7`](https://stellar.expert/explorer/testnet/tx/9267b1c7444de52c22eb5cc4807768decb4b942bd4a2f48b09723b2febdb62bb) | [`8f7d275f`](https://stellar.expert/explorer/testnet/tx/8f7d275ffa98ab3bba66b4e341f931cc39d2a1f1db74c2031e602e833d935544) |

All four transactions report `successful: true`. With these, every new handle
type (GitHub, Discord, Telegram) has at least one arbitrary-amount
deposit-to-claim cycle on testnet.

Earlier these two were blocked: `/resolve` returned 404 because the handles had
no linked wallet (`backend/src/resolver.ts`, the `!user.wallet` branch). Linking
a wallet to each, the step above, is what unblocked them. No code change.

## Token choice

Cycles ran in XLM rather than USDC. The sender accounts available to an
unattended harness (`zeekpay-bench`, `bullet-admin`) hold XLM only, and testnet
USDC slot 0 is Circle's own issuer
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, which we cannot
mint from. Nothing in the path is token-specific: the commitment binds
`tokenId`, the proof binds it, and the contract looks the SAC up by slot, so a
USDC cycle differs from these only in which SAC is called and in needing a
trustline first. Re-running in USDC needs a funded USDC balance on the sender,
nothing more.

## Anomalies found during the run

**A root race in the claim path, now fixed in the harness.** The indexer
inserts a leaf and posts the resulting Merkle root as two separate steps, so
`/path` hands back a root that is briefly not yet on-chain. Claiming in that
window fails with `Error(Contract, #5)`, `UnknownRoot`. Retrying the same proof
does not recover: by then the indexer may have advanced to a newer root, and
the one the proof commits to is never posted. The harness now simulates
`is_known_root` after proving and re-proves against the current tree until the
root it holds is one the contract accepts. Worth noting for the app too, where
the same race is possible and the user-visible result is a failed claim.

**Two deposits were stranded before that fix landed**, because the first
version of the harness generated the note secret in memory and only recorded it
after a successful claim:

| Deposit | Amount | Addressed to |
| --- | --- | --- |
| [`b411ac03`](https://stellar.expert/explorer/testnet/tx/b411ac03216d6fa506e0bed01ab01e2701204cd32b49009bf3478b6075d19d6f) | 2.7182818 XLM | `github:vkenjo` |
| [`1780e77c`](https://stellar.expert/explorer/testnet/tx/1780e77c9268ff4adddca68be18172d07d3ea226802a2e6c3ea76cf80313d46e) | 1.6180339 XLM | `github:lancecolorina` |

Both confirmed on-chain and both unclaimable: their secrets are gone, so no
proof can ever be produced for them, and 4.3363157 testnet XLM is permanently
held by the pool. They are listed here rather than omitted because they are
visible in the contract's history and a reviewer counting deposit events would
otherwise find eight deposits against six claims. The harness now writes the
secret before submitting the deposit and has an `E2E_RESUME=1` mode that
settles any deposit that landed without a claim; cycle 3 above was completed
that way after a transient network failure, which is the fix working.

## Reproducing this

```sh
cd frontend
E2E_SENDER_SECRET=$(stellar keys show zeekpay-bench) \
E2E_RECIP_1_SECRET=… E2E_RECIP_2_SECRET=… E2E_RECIP_3_SECRET=… \
npx tsx --env-file=../.env scripts/e2e_cycles.mts
```

`E2E_SKIP` and `E2E_LIMIT` run a window of the cycle list; `E2E_RESUME=1`
claims deposits that already landed instead of making new ones. Output goes to
`frontend/scripts/e2e_results.json`, which is gitignored because it holds note
secrets: anyone with that file can claim any note in it.
