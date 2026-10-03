// High-level shielded-pool operations the UI calls. Each returns the note(s)
// the caller must persist: a pool note is a spendable balance, and losing its
// secret loses the money.
//
// Funding reuses the existing `deposit` entry point rather than an all-dummy
// `transact`: a deposit note's commitment is Poseidon([secret, digest, value,
// tokenId]), exactly a pool note, so it is spendable through `transact` once
// indexed. That path is the one deposit.ts already ships and the one the D4 run
// exercised, so funding rides on tested code. Spends (withdraw, transfer) go
// through `transact`.

import { depositNote } from "./deposit";
import { ensureTrustline } from "./trustline";
import { leafIndexFromPathIndices, noteCommitment, type PoolNote } from "./pool_note";
import { dummyInput, submitTransact, type PoolInput } from "./pool_tx";
import { waitForSpendablePath } from "./pool_path";

type SignTx = (xdr: string) => Promise<string>;
type OnStatus = (label: string) => void;

function randomFieldElement(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  b[0] = 0; // keep below the BLS12-381 field order
  return BigInt(
    "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")
  ).toString();
}

/** A fresh zero-value output note. Pool shape needs two outputs even when only
 *  one carries value; the throwaway still needs a unique secret so its
 *  commitment (and the nullifier it would later yield) never collides. */
function zeroNote(tokenId: number): PoolNote {
  return { secret: randomFieldElement(), recipientDigest: "0", value: 0n, tokenId };
}

/** Make a brand-new owned note of `value`, owned by `ownerDigest`. The secret is
 *  generated here and returned inside the note; persist it. */
export function newNote(ownerDigest: string, value: bigint, tokenId: number): PoolNote {
  return { secret: randomFieldElement(), recipientDigest: ownerDigest, value, tokenId };
}

export interface FundResult {
  note: PoolNote;
  txHash: string;
}

/**
 * Deposit an ALREADY-CREATED note into the pool. Separate from note creation on
 * purpose: the caller persists the note (its secret is the money) BEFORE calling
 * this, so a crash between the on-chain deposit and persistence cannot strand
 * the funds. Returns the deposit tx hash.
 */
export async function depositExistingNote(
  signerAddress: string,
  note: PoolNote,
  signTx: SignTx,
  onStatus?: OnStatus
): Promise<string> {
  onStatus?.("Shielding");
  return depositNote(
    signerAddress,
    BigInt(noteCommitment(note)),
    note.value,
    signTx,
    note.tokenId
  );
}

/**
 * Convenience for callers that do not need the persist-before-deposit split
 * (scripts, tests): make a note and deposit it in one call. UI code should use
 * newNote + depositExistingNote so the secret is saved first.
 */
export async function fundPool(
  signerAddress: string,
  amount: bigint,
  tokenId: number,
  ownerDigest: string,
  signTx: SignTx,
  onStatus?: OnStatus
): Promise<FundResult> {
  const note = newNote(ownerDigest, amount, tokenId);
  const txHash = await depositExistingNote(signerAddress, note, signTx, onStatus);
  return { note, txHash };
}

/**
 * Withdraw a pool note's full value to `toAddress` (an ordinary Stellar
 * account). Waits for the note to be spendable, ensures the destination can
 * hold the asset, then spends the note with a visible withdraw leg. The note is
 * consumed; its nullifier is now used.
 */
export async function withdrawNote(
  signerAddress: string,
  note: PoolNote,
  toAddress: string,
  signTx: SignTx,
  onStatus?: OnStatus
): Promise<string> {
  await ensureTrustline(note.tokenId, toAddress, signTx, onStatus);
  const commitment = noteCommitment(note);
  const path = await waitForSpendablePath(commitment, signerAddress, onStatus);
  const spent: PoolNote = {
    ...note,
    leafIndex: leafIndexFromPathIndices(path.pathIndices),
  };
  const inputs: PoolInput[] = [
    { note: spent, path, isDummy: false },
    dummyInput(),
  ];
  return submitTransact(
    signerAddress,
    {
      inputs,
      outputs: [zeroNote(note.tokenId), zeroNote(note.tokenId)],
      publicDeposit: 0n,
      publicWithdraw: note.value,
      root: path.root,
      depositor: signerAddress,
      recipient: toAddress,
    },
    signTx,
    onStatus
  );
}

export interface TransferResult {
  txHash: string;
  /** The note now owned by the recipient. Deliver it to them (encrypted). */
  recipientNote: PoolNote;
  /** The sender's change note, if any value was left over. Persist it. */
  changeNote?: PoolNote;
}

/**
 * Pay `value` to `recipientDigest` entirely inside the pool: nothing of the
 * amount appears on-chain. Spends `note`, creates the recipient's note and a
 * change note for the remainder. Both public legs are zero.
 */
export async function transferNote(
  signerAddress: string,
  note: PoolNote,
  recipientDigest: string,
  value: bigint,
  ownerDigest: string,
  signTx: SignTx,
  onStatus?: OnStatus
): Promise<TransferResult> {
  if (value <= 0n || value > note.value) {
    throw new Error("transfer amount must be positive and at most the note value");
  }
  const commitment = noteCommitment(note);
  const path = await waitForSpendablePath(commitment, signerAddress, onStatus);
  const spent: PoolNote = {
    ...note,
    leafIndex: leafIndexFromPathIndices(path.pathIndices),
  };
  const recipientNote = newNote(recipientDigest, value, note.tokenId);
  const change = note.value - value;
  const changeNote = newNote(ownerDigest, change, note.tokenId);

  const txHash = await submitTransact(
    signerAddress,
    {
      inputs: [{ note: spent, path, isDummy: false }, dummyInput()],
      outputs: [recipientNote, changeNote],
      publicDeposit: 0n,
      publicWithdraw: 0n,
      root: path.root,
      depositor: signerAddress,
      recipient: signerAddress,
    },
    signTx,
    onStatus
  );
  return { txHash, recipientNote, changeNote: change > 0n ? changeNote : undefined };
}
