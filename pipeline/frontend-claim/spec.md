# frontend-claim — Spec

## Goal

Wire up the "Claim" button on `/claim?p=...`: generate a real Groth16 proof,
post the Merkle root on-chain, submit the Soroban `claim(...)` transaction via
Freighter, and show success + tx link.

---

## Backend additions

### `POST /prove`
Input: `{ secret, recipientDigest, denom }` (all decimal strings).
1. Run `compute_hashes.wasm` witness → extract `nullifier`, `root`, `pathElements`
   (zero-hash siblings for a single-leaf depth-20 tree at index 0).
2. Build `claim_input.json`; run `snarkjs groth16 prove claim.zkey`.
3. Convert proof to Soroban byte layout (same encoding as `convert-to-soroban.mjs`):
   - G1 = BE(X, 48 bytes) || BE(Y, 48 bytes)
   - G2 = BE(X_c1, 48) || BE(X_c0, 48) || BE(Y_c1, 48) || BE(Y_c0, 48) — c1 first
   - Fr = BE(32 bytes)
4. Return `{ proof_a, proof_b, proof_c, nullifier, root }` (all hex strings).
5. Returns 503 if `pnpm build:circuits` artifacts are missing.

### `POST /post-root`
Input: `{ root }` (64-char hex).
Requires `ZEEKPAY_ADMIN_KEY` (Stellar secret key) env var.
Calls `post_root(root)` on-chain via stellar-sdk; polls for finality.
Returns `{ ok: true, hash }`. Returns 503 if admin key not configured.

---

## Frontend additions

### `lib/claim_tx.ts` (new)
`claimNote(connectedAddress, proofA, proofB, proofC, root, nullifier, denom, signTx)`
Builds Soroban `claim(proof_a, proof_b, proof_c, root, nullifier, recipient, denom)` tx.
XDR encoding:
- `BytesN<96>` → `scvBytes(hexToBuffer(proofA))`
- `BytesN<192>` → `scvBytes(hexToBuffer(proofB))`
- `Address` → `nativeToScVal(connectedAddress, { type: "address" })`
- `Denom` → `scvVec([scvSymbol("One"|"Ten"|"Fifty"|"Hundred")])`
Submits, polls via `rpc.pollTransaction(hash, { attempts: 30 })`, returns hash.

### `components/ClaimView.tsx` (modified)
New states: `proving`, `signing`, `submitting`, `done`.
Flow after "Claim" button click:
1. `proving` — POST /prove (~15 s) → POST /post-root (~5 s)
2. `signing` — Freighter popup for claim tx signature
3. `submitting` — tx submitted, polling for finality
4. `done` — success card with tx link on stellar.expert

Error at any step resets to `matched` with error message.

---

## New env vars

```
ZEEKPAY_ADMIN_KEY=      # backend — Stellar secret key for post_root (never commit)
SOROBAN_RPC_URL=        # backend — defaults to testnet
NETWORK_PASSPHRASE=     # backend — defaults to testnet
NEXT_PUBLIC_NETWORK_PASSPHRASE=  # frontend — for Freighter sign call
NEXT_PUBLIC_FRONTEND_URL=        # frontend — for claim link encoding
```

---

## Merkle tree assumptions (single-note demo)

For a fresh deposit, the tree has one leaf at index 0; all siblings are zero.
`pathElements[0] = "0"` (hardcoded), `pathElements[i] = zeroHashes[i-1]`
extracted from the helper circuit witness. `pathIndices = [0, ..., 0]`.
The root is deterministic for given `(secret, recipientDigest, denom)`.

Multi-note trees (real Merkle accumulator) are deferred post-hackathon.
