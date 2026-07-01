# frontend-inbox — Spec

## Goal

`/claim?p=...` page: recipient opens their claim link, sees note details
($X USDC on testnet), connects Freighter, and clicks "Claim". This is the
recipient-facing entry point for the ZeekPay flow.

---

## Why `/claim`, not `/inbox`

Notes are shared out-of-band (DM, etc.) as claim links:
```
http://localhost:3000/claim?p={base64url}
```
The recipient clicks the link and lands on `/claim?p=...`. There is no
server-side registry of "notes for me" — the claim link IS the inbox item.
A separate `/inbox` paste-field page adds friction without value.

---

## Page: `/claim`

### Route

`/claim?p={base64url(ClaimPayload)}` — URL param `p` is decoded
client-side using `decodeClaimLink` from `@/lib/claim_link`.

### States

| State | Display |
|-------|---------|
| `no_link` | "No claim link found. Ask your sender for the link." |
| `invalid` | "Invalid claim link." |
| `ready` | Note card: denomination, network, contract (masked). "Connect & Claim" button. |
| `connecting` | "Connecting Freighter…" |
| `proving` | "Generating proof… (this takes ~10 s)" |
| `submitting` | "Submitting…" |
| `done` | "Claimed! Your USDC has been sent to your wallet." + tx link |
| `error` | Error message + retry |

**This feature ships `ready` + `connecting` states only.**
`proving` and `submitting` are the claim-execution states, implemented in
`frontend-claim`. The "Connect & Claim" button in this feature connects
Freighter and verifies the connected address matches the note's
`recipientDigest` — then shows "Claim" (disabled, pending frontend-claim).

### recipientDigest verification

After Freighter connects, compute `computeRecipientDigest(connectedAddress)`
and compare to `payload.recipientDigest`. If mismatch: show
"This note is not for this wallet address."

---

## Files

| File | Change |
|------|--------|
| `frontend/src/app/claim/page.tsx` | Server component wrapper (reads `?p=` searchParam, passes to `ClaimView`) |
| `frontend/src/components/ClaimView.tsx` | "use client"; full state machine as above |

No new backend routes. No new dependencies. Reuses:
- `decodeClaimLink` from `@/lib/claim_link`
- `computeRecipientDigest` from `@/lib/recipient`
- `@stellar/freighter-api` dynamic import (same pattern as SendForm)

---

## ClaimPayload (reminder)

```typescript
interface ClaimPayload {
  secret: string;           // hex, 64 chars
  recipientDigest: string;  // decimal bigint string
  denom: 1 | 10 | 50 | 100;
  contractId: string;
  network: "testnet";
}
```

---

## Out of scope (frontend-claim)

- Generating the Groth16 proof (snarkjs full-prove via backend)
- Building + submitting the Soroban `claim(...)` transaction
- Polling for transaction finality

---

## Tests

Build: `next build` must remain clean.
Manual: open a claim link produced by the `/send` page, verify note card
renders with correct denomination; connect wrong wallet, verify mismatch warning.
