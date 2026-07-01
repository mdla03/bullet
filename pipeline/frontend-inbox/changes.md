# frontend-inbox — Changes

## Frontend

### `frontend/src/app/claim/page.tsx` (new)
Server component. Awaits `searchParams` (Next.js 15 async), extracts `p`,
passes to `<ClaimView encoded={p ?? ""} />`.

### `frontend/src/components/ClaimView.tsx` (new)
"use client". State machine: `no_link | invalid | ready | connecting | matched | mismatch | error`.

- Init is synchronous (no `useEffect` / flash): `decodeClaimLink` called inside
  `useState` initializer using a reconstructed URL (`http://localhost/claim?p=...`).
- `handleConnect`: dynamic-imports Freighter, calls `getAddress()`, then
  `computeRecipientDigest(addr)` and compares to `payload.recipientDigest`.
  Mismatch shows a yellow warning; match shows the disabled "Claim" button (stub
  for `frontend-claim`).
- Reuses `decodeClaimLink` + `ClaimPayload` from `@/lib/claim_link` and
  `computeRecipientDigest` from `@/lib/recipient`. No new deps.

## No backend changes.
