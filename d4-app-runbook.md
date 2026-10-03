# Running the D4 cycles through the live app

This is the half of Deliverable 4 that cannot be automated: a browser extension
cannot be driven unattended, so the six cycles that should appear in the
product's own numbers have to be done by hand at https://sendbullet.xyz. It
doubles as the shot list for the demo video, so record the screen while working
through it and one pass produces both.

The unattended harness run (`d4-validation.md`) already proves the path works
on-chain. What this adds is the thing a script cannot produce: activity the app
itself recorded, and footage of a person using it.

## Before you start

**1. Link a wallet to the Discord and Telegram accounts.** This is the blocker
that kept the harness to GitHub only. `GET /resolve` returns 404 for
`discord:mark.0310` and `telegram:mla032` because the accounts holding those
handles have no wallet attached, and a payment cannot be addressed to a handle
that resolves to no published key. Sign in to sendbullet.xyz as each of those
identities and connect Freighter. Confirm both resolve before sending anything:

```sh
curl -s 'https://bullet-backend.up.railway.app/resolve?q=discord:mark.0310'  | head -c 200
curl -s 'https://bullet-backend.up.railway.app/resolve?q=telegram:mla032'    | head -c 200
```

Both must come back `"found":true` with a `zeekPayPubKey`.

**2. Decide who the recipients are.** The SOW's adoption target is "≥ 3 test
users". Six cycles between your own GitHub, Discord and Telegram accounts covers
all three handle types but is one person wearing three hats, and a reviewer can
see that from the handle list. If you want the three-users line to hold without
a caveat, get two other people to receive at least one payment each.

**3. Claim from the inbox, not the claim link.** This decides whether the
dashboard sees the claim at all. `Inbox.tsx` records a `claim` activity row;
`ClaimView.tsx`, the copy-paste claim-link path, records nothing. Claim-link
claims are real on-chain and invisible to the dashboard. Use the inbox for these
six unless you are deliberately filming the claim-link flow.

**4. Fund the sending wallet** with testnet XLM, or with testnet USDC if you
want the cycles denominated the way the SOW text describes.

## The six cycles

Amounts are deliberately odd and all different. A round number is itself a leak,
and two cycles sharing an amount would pair on the explorer.

| # | Send to | Amount | Use case being shown |
| --- | --- | --- | --- |
| 1 | `github:mdla03` | 4.2451098 | Bounty payout to a builder's GitHub |
| 2 | `discord:mark.0310` | 9.3317792 | Bounty payout to a DAO contributor's Discord |
| 3 | `telegram:mla032` | 1.0845622 | Pseudonymous income at a Telegram handle |
| 4 | `github:mdla03` | 6.7190334 | Repeat payment, same handle, to show stealth addressing |
| 5 | `discord:mark.0310` | 2.8806471 | Private peer transfer, paying someone back |
| 6 | `telegram:mla032` | 11.5362907 | Private tip to a creator |

Cycle 4 matters more than it looks. Send twice to the same handle and the two
deposits share no on-chain value, because each payment derives a fresh stealth
`recipientDigest` from an ephemeral X25519 key. That is worth showing on the
explorer side by side.

For each cycle: enter the handle, enter the amount, sign the deposit in
Freighter, then switch to the recipient account, open the inbox, and claim.
Record the deposit and claim transaction hashes as you go.

## What to capture for the video

The SOW asks for three featured use cases. Cycles 1 to 3 cover them; the rest
are repeats that strengthen the evidence.

1. **Private peer and OTC transfer.** Cycle 5. Point out that you typed a handle,
   never a wallet address.
2. **Bounty and grant payouts.** Cycles 1 and 2. A contributor is paid an odd
   amount at their GitHub or Discord handle, with no public record mapping that
   handle to their total income.
3. **Pseudonymous income.** Cycles 3 and 6. An anonymous builder receives money
   at a Telegram handle with nothing tying it to a public identity.

Then the explorer beats, which are the part a non-technical reviewer can check:

- Open a deposit on Stellar Expert. The `deposit` event carries a commitment and
  a leaf index. No sender, no amount, no token, and nothing naming the handle.
- Open its claim. The `claim` event carries a nullifier and a Pedersen amount
  commitment. No note commitment, so there is no shared field joining it to the
  deposit it spends.
- Show the two side by side and say plainly what is and is not hidden: the link
  is absent, the amount is not. The amount is visible on both legs because
  `deposit` and `claim` take it as a plaintext argument.
- Then show the shielded-pool transaction from the harness run,
  [`862420b9`](https://stellar.expert/explorer/testnet/tx/862420b9fb37b0200e2c53fcba995c7e95b3f6bb5f1d7a2faed882c560778237).
  Its effects list is empty. It moved 7.7777777 XLM between two parties and the
  explorer shows no amount, no asset and no counterparty. That is the amount
  privacy, and it is honest to say it is reachable against the contract but not
  yet wired into the UI.

Do not claim more than the design gives. "Nothing on-chain connects your deposit
to their claim" is true. "Nobody can see the amount" is only true of the pool
path.

## After the run

Expect the dashboard to move: six `send` rows, and six `claim` rows if you
claimed from the inbox. `transactions` goes up by 12, and `volume` counts each
payment twice, once on the send and once on the claim, which is how it has always
counted. `active_accounts` only moves for an account whose first-ever action this
was.

Add the twelve hashes to `d4-validation.md` alongside the harness table, marked
as app-driven rather than harness-driven. The two sets are different evidence:
one shows the path works unattended, the other shows a person using the shipped
product.
