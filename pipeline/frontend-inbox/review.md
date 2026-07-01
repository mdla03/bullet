# frontend-inbox — Review

## Correctness

- `decodeClaimLink` expects a full URL; the component reconstructs one from
  the raw `p` param using `http://localhost/claim?p=...`. This works because
  `new URL(...)` only needs a syntactically valid URL — the host is irrelevant.
- `recipientDigest` comparison uses `.toString()` on the bigint returned by
  `computeRecipientDigest`, which matches how `SendForm` stores it as a decimal
  string in the payload. ✓
- `useState` initializer runs once at mount, synchronously — no `useEffect`
  needed, no flicker between "decoding" and final state.

## Security

- The `secret` inside `ClaimPayload` is present in the URL `p` param and
  therefore in browser history and server logs. This is an accepted hackathon
  limitation (documented in frontend-send review). The claim step (frontend-claim)
  consumes `secret` to generate the ZK proof; after claiming, the secret has no
  further value.
- No sensitive data sent to any server from this page.

## UX

- Wrong-wallet path shows a yellow warning and re-exposes "Connect Wallet" so
  the user can switch wallets and retry.
- "Claim" button is visibly disabled (greyed, `cursor-not-allowed`) pending
  `frontend-claim`. Avoids a dead click; no confusing spinner.

## Known limitations (carried forward)

- Claim execution not yet implemented (frontend-claim).
- No on-chain check that the commitment actually exists / hasn't been claimed.
  That verification is part of frontend-claim (the Soroban `claim` call will
  reject a spent nullifier or unknown root).
