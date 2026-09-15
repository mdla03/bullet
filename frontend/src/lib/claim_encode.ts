// Shared claim-transaction encoding, used by both claim_tx.ts (direct claim)
// and invite_claim.ts (custody-wallet claim). Kept identical between the two
// paths since the contract's claim argument order and byte layout must match
// exactly regardless of who signs the transaction.

import * as StellarSdk from "@stellar/stellar-sdk";

export function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

/**
 * amountCommitmentX/Y are the 64-char hex (32-byte BE) Fr coordinates of the
 * Pedersen amount commitment (publicSignals[5]/[6] from the claim circuit);
 * concatenated BE(X) || BE(Y) into the contract's 64-byte `amount_commitment`
 * argument.
 */
export function encodeAmountCommitment(
  amountCommitmentX: string,
  amountCommitmentY: string
): Buffer {
  return Buffer.concat([
    hexToBuffer(amountCommitmentX),
    hexToBuffer(amountCommitmentY),
  ]);
}

export interface ClaimOperationArgs {
  proofA: string;
  proofB: string;
  proofC: string;
  root: string;
  nullifier: string;
  recipientDigest: string;
  recipient: string;
  amount: bigint;
  tokenId: number;
  amountCommitmentX: string;
  amountCommitmentY: string;
}

/**
 * Build the Soroban
 * claim(proof_a, proof_b, proof_c, root, nullifier, recipient_digest,
 *       recipient, amount, token_id, amount_commitment)
 * operation. Argument order must match the contract exactly.
 */
export function buildClaimOperation(
  contract: StellarSdk.Contract,
  args: ClaimOperationArgs
): StellarSdk.xdr.Operation {
  const { xdr } = StellarSdk;
  return contract.call(
    "claim",
    xdr.ScVal.scvBytes(hexToBuffer(args.proofA)),
    xdr.ScVal.scvBytes(hexToBuffer(args.proofB)),
    xdr.ScVal.scvBytes(hexToBuffer(args.proofC)),
    xdr.ScVal.scvBytes(hexToBuffer(args.root)),
    xdr.ScVal.scvBytes(hexToBuffer(args.nullifier)),
    xdr.ScVal.scvBytes(hexToBuffer(args.recipientDigest)),
    StellarSdk.nativeToScVal(args.recipient, { type: "address" }),
    StellarSdk.nativeToScVal(args.amount, { type: "i128" }),
    StellarSdk.nativeToScVal(args.tokenId, { type: "u32" }),
    xdr.ScVal.scvBytes(
      encodeAmountCommitment(args.amountCommitmentX, args.amountCommitmentY)
    )
  );
}
