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
no visible value at all. That path was then exercised against the same deployed
contract. It works. See the next section.

## Hiding the amount: the shielded-pool path

`transact` is live on the deployed contract (`PoolVk` is set in its instance
storage) and the deployed indexer already ingests the `note` events it emits, so
no deploy and no contract change were needed to run this. Driven by
`frontend/scripts/pool_hidden_amount.mts`, three transactions, one payment:

| Step | Transaction | What an observer sees |
| --- | --- | --- |
| 1. Fund the pool | [`d47eea37`](https://stellar.expert/explorer/testnet/tx/d47eea37aa0e7cdfe8a38c200903a9e58a0e4421992f06e18d15d25c753bd30b) | `12.3456789 XLM` debited from the funder, credited to the contract |
| 2. **In-pool transfer of 7.7777777 XLM** | [`862420b9`](https://stellar.expert/explorer/testnet/tx/862420b9fb37b0200e2c53fcba995c7e95b3f6bb5f1d7a2faed882c560778237) | **Nothing.** Zero balance effects. No amount, no asset, no sender, no recipient. |
| 3. Withdraw | [`e360e3c6`](https://stellar.expert/explorer/testnet/tx/e360e3c6022f9582000004b3771994371d1f4e47a8faa440cf095f18ca86fcd1) | `7.7777777 XLM` debited from the contract, credited to a wallet |

Step 2 is the whole point. Read back from Horizon, that transaction's effects
list is **empty**: a single `invoke_host_function` whose arguments are field
elements, which spends one note and creates two (7.7777777 to the recipient,
4.5679012 back as change) while moving no asset at all. The amounts live inside
Poseidon commitments, and the circuit's balance constraint
`sum(inputs) + deposit == sum(outputs) + withdraw` is what stops the pool paying
out more than went in, without any value appearing on-chain.

Because the transferred amount never has to equal the funded amount, the two
visible legs no longer pair: `12.3456789` entered and `7.7777777` left, with the
remainder still shielded in the pool as a note. That is the correlation the
deposit/claim path cannot break.

What this does not hide, and no shielded pool does: value entering the pool and
value leaving it are both visible, because a token contract has to move real
balances at the edges. An observer learns that someone funded the pool and that
someone withdrew from it. They do not learn who paid whom, or how much changed
hands inside. This is the same boundary Zcash has.

The gap that remains is product, not cryptography: nothing in `frontend/` or
`backend/` calls `transact`, so this is reachable from a script against the
deployed contract but not yet from sendbullet.xyz. Shipping it means a note
wallet in the UI (notes are spendable balances, not one-shot claim links) and a
send path that routes through the pool instead of deposit/claim.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| At least 6 arbitrary-amount deposit-to-claim cycles on testnet | **Met.** 6 cycles, 12 transactions, all verified on-chain. |
| Covering all three new handle types | **Not met.** All six are GitHub. Discord and Telegram are blocked, see below. |
| Testnet transaction hashes for all 6+ cycles | **Met.** Table above. |
| Updated public GitHub repository | **Met.** This document and `frontend/scripts/e2e_cycles.mts`. |
| Deployed to sendbullet.xyz | **Met.** Resolution, Merkle paths and the proving key all came from the deployed services during the run. |
| Stellar Expert shows no visible amount | **Met on the shielded-pool path, not on the path the app ships.** Transaction `862420b9` moves 7.7777777 XLM with zero balance effects. The deposit/claim flow the live UI uses still shows the amount on both legs. |
| Demo video of the live app | **Outstanding.** Needs screen capture and Freighter interaction. |

### Why Discord and Telegram could not be exercised

`GET /resolve` returns 404 for `discord:mark.0310`, `discord:sendbulletxyz` and
`telegram:mla032`, while all eight GitHub handles and the X and Google handles
resolve normally. The handle rows exist, as the 2026-09-28 verification report
records, so the 404 is `/resolve` declining to return instructions for an
account with no linked wallet (`backend/src/resolver.ts`, the `!user.wallet`
branch). A payment cannot be addressed to a handle that resolves to no
published key.

Unblocking it is an account action, not a code change: sign in to sendbullet.xyz
as those Discord and Telegram identities and link a wallet to each. The harness
needs no modification afterwards. Add the two handles to its `CYCLES` list and
re-run.

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
