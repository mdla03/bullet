# shielded-pool — Plan (spec.md)

Status: design, not yet implemented. Written 2026-08-20.

## Goal

Replace the current one-note-in/one-note-out claim circuit with a 2-in/2-out
join-split circuit and a pool contract, so that:

- Amounts of in-pool transfers are hidden.
- Deposits and withdrawals stop corresponding one to one, breaking the link
  between them.
- Arbitrary amounts work without leaking through fixed denominations.
- The pool cannot pay out more than was put in, enforced in-circuit.

## Honest scope: what this does and does not hide

Read this before writing any user-facing copy.

**Hidden:** the value and recipient of any transfer that stays inside the
pool. The correspondence between a given deposit and a given withdrawal.

**Still public:** the deposit leg and the withdrawal leg are ordinary SAC
transfers, and their amounts are visible in the transaction. This is
structural on Stellar and no circuit changes it. The model is the same as
Zcash: public in, private inside, public out.

**Depends on usage, not cryptography:** if one person deposits 137.42 USDC and
another withdraws 137.42 USDC shortly after with no other traffic, the two are
trivially linkable. Privacy here is a function of the anonymity set. On a
testnet demo with three users the anonymity set is three. Do not describe the
pool as private without saying what the set size is.

## Why this, and not a patch

The open audit finding from D1 is that `deposit` records a commitment with no
check that it commits to the deposited amount, because the contract cannot
inspect a hash over a secret it does not know. Someone can deposit one stroop
against a commitment for ten USDC and claim ten USDC.

No contract-side guard fixes that. The fix is the balance constraint below,
which is a property of the circuit rather than the contract. The shielded pool
is therefore the correct repair for a live security hole, not only a privacy
feature.

## Proof statement

The prover knows two input notes and constructs two output notes such that:

1. Each non-dummy input note's commitment is in the Merkle tree at `root`.
2. Each input nullifier is correctly derived and bound to that note's position.
3. Each output commitment is well formed.
4. Every note value and both public amounts are in `[0, 2^64)`.
5. All four notes carry the public `tokenId`.
6. **Balance:** `inputs + publicDeposit == outputs + publicWithdraw`.

Constraint 6 is the security core. A bug there mints value from nothing.

## Note structure

Unchanged from the current circuit, deliberately, so no new hash shape and no
new security caveat is introduced:

```
commitment = Poseidon([secret, recipientDigest, value, tokenId])
```

## Nullifier: one change from today

Today `nullifier = Poseidon([secret])`. In a pool that is not enough: two notes
sharing a secret produce the same nullifier, so only one is ever spendable.
Bind it to the note's position:

```
nullifier = Poseidon([secret, leafIndex])
```

Dummy inputs use a fresh random secret, so their nullifiers are random field
elements and collide only with negligible probability. The contract records
both nullifiers unconditionally and does not need to know which were dummies.

Carried over, unchanged and still true: whoever knows a note's secret can spend
it, including the original sender. Claim links are bearer instruments. That is
a property of the existing design, not something this feature introduces or
fixes.

## Public inputs (order LOCKED once the contract ships)

```
[root, nullifier0, nullifier1, commitmentOut0, commitmentOut1,
 publicDeposit, publicWithdraw, tokenId]
```

Eight inputs. Measured verification cost below. As with the claim circuit,
never insert or reorder; append only.

`publicDeposit` and `publicWithdraw` are kept as two non-negative signals
rather than one signed amount, because a field element has no meaningful sign
and encoding one invites exactly the kind of wraparound bug this circuit
exists to prevent. A pure in-pool transfer sets both to zero.

## Private inputs

Per input note `i` in {0,1}: `secret[i]`, `recipientDigest[i]`, `value[i]`,
`leafIndex[i]`, `pathElements[i][20]`, `pathIndices[i][20]`, `isDummy[i]`.

Per output note `j` in {0,1}: `secretOut[j]`, `recipientDigestOut[j]`,
`valueOut[j]`.

## Dummy inputs

A deposit with no existing notes still needs two inputs. `isDummy[i]` is
constrained boolean, and:

- `isDummy[i] * value[i] === 0`, so a dummy is worth nothing.
- Merkle membership is enforced as
  `(1 - isDummy[i]) * (computedRoot[i] - root) === 0`, so the check binds only
  for real notes.

Marking a real note dummy gains nothing, since the value is then forced to
zero and it contributes nothing to the balance.

## Overflow argument for the balance constraint

Every value is range-proofed to 64 bits before the sum is formed. The largest
possible sum is four notes plus two public amounts, under `6 * 2^64 < 2^67`,
which is far below the BLS12-381 scalar field modulus at roughly `2^255`. The
sum therefore cannot wrap, and the equality means what it appears to mean.

This argument is load-bearing. If anyone widens `AMOUNT_BITS` or adds inputs,
recheck it.

## Measured on-chain verification cost

Real measurements from `contracts/verifier`, not extrapolation:

| Shape | Public inputs | CPU instructions | % of 1e8 budget |
|---|---:|---:|---:|
| MSM-9, this design | 8 | 80,650,114 | 80.65% |
| MSM-11, 3-in/3-out | 10 | 83,634,323 | 83.63% |
| MSM-13, 4-in/4-out | 12 | 86,618,549 | 86.62% |

The 2-in/2-out design fits with about 19% headroom, and there is room to grow
the join-split later without leaving the budget.

## Trusted setup: this is the expensive change

Two Merkle paths roughly double the dominant cost. Rough estimate is 22k to 26k
constraints against today's 12,133, which overflows pot14 at 16,384. Expect to
need pot15 at 32,768, which means:

- A fresh ceremony. The current one cannot be reused.
- A larger zkey, likely 15 to 20 MB against today's 7.9 MB.
- Browser proving in the 2 to 3 second range against today's 1.35 s.
- A larger artifact download, which is already the dominant cost in claim UX.

Confirm the real constraint count by compiling before committing to a power.

## Contract changes

- Accept two nullifiers and two output commitments per spend.
- Reject either nullifier if already used, and record both after verification.
- Move tokens only for the public legs: pull `publicDeposit`, pay
  `publicWithdraw`.
- Keep the `AMOUNT_MAX_EXCLUSIVE` bound on both public amounts, matching the
  circuit's 64-bit range proofs. Both halves stay, as documented in
  `circuits/src/claim.circom`.

The awkward part is the Merkle tree. It is currently off-chain with an admin
posting roots, which is the documented Option B trust seam. A pool advances the
tree on every spend, so that seam and its latency become far more load-bearing
than they are today. Decide explicitly whether the tree moves on-chain before
building the contract half.

## Frontend: the underestimated part

Wallets must track notes like UTXOs, including change notes. A user's balance
becomes a set of fragments, every send becomes a note-selection problem, and a
lost note is lost funds. Budget real time for this. It is not a thin layer over
the circuit.

## Test plan

Beyond the existing claim-circuit vectors:

- Balance violation: outputs exceeding inputs must be unsatisfiable.
- Overflow attempt: values chosen to wrap the field must be caught by the range
  proofs, not by the balance equation.
- Dummy abuse: a dummy input with non-zero value must be unsatisfiable.
- Double spend: replaying either nullifier must be rejected on-chain.
- Cross-token: notes whose tokenId differs from the public one must fail.
- Pure deposit, pure withdrawal, and pure in-pool transfer must each work.
- A regression test that over-funds the pool, in the style of
  `claim_amount_at_or_above_2_64_rejected`, so a drain is blocked by a
  constraint rather than by an empty balance.

Every test that asserts a failure must be verified to fail for the intended
reason. The D1 audit produced two tests that passed for the wrong reason before
that check was applied.

## Not built in this feature

- Multi-recipient batch send. A 2-in/2-out join-split gives one recipient plus
  change per transaction.
- Mainnet deployment, and the production multi-party ceremony it requires.
- External audit. A flawed balance check is how a pool mints money, and this
  design has had no third-party review.
