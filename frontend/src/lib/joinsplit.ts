// Witness for a send: a join-split (circuits/src/joinsplit.circom) with two
// dummy inputs, `publicDeposit = amount`, one real output note for the
// recipient and one zero-value output back to the sender.
//
// Public inputs, in the circuit's locked order:
//   [root, nullifier0, nullifier1, commitmentOut0, commitmentOut1,
//    publicDeposit, publicWithdraw, tokenId, ownerDigest]
// The contract derives ownerDigest from its `owner` argument, so it must be
// the digest of the address that signs the transact call (the sender).
//
// Pure apart from the injected randomness, so it can be checked in node
// against the real circuit wasm (joinsplit.test.ts).

import { poseidon } from "./poseidon";
import { noteNullifier } from "./commitment";
import { computeRecipientDigest } from "./recipient";

export const DEPTH = 20;
const AMOUNT_LIMIT = 1n << 64n;

/** 32 random bytes with the top byte zeroed (always < BLS12-381 r), as hex. */
export function randomSecretHex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  b[0] = 0;
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const hexToDec = (h: string) => BigInt("0x" + h).toString();

export interface SendWitness {
  /** snarkjs input object for joinsplit.wasm. */
  input: Record<string, unknown>;
  /** The public signals the proof must come back with, in circuit order. */
  publicSignals: string[];
  nullifiers: [string, string];
  commitments: [string, string];
  ownerDigest: string;
  /** The recipient's note: what the claim link and inbox note carry. */
  note: { secretHex: string; recipientDigest: string; commitment: string };
}

export async function buildSendWitness(args: {
  owner: string;      // sender G-address, signs transact as owner and depositor
  recipient: string;  // G-address the note is addressed to (only it can claim)
  amount: bigint;     // stroops
  tokenId: number;
  root: string;       // decimal, a root the contract has accepted
  randomHex?: () => string;
}): Promise<SendWitness> {
  const { amount, tokenId, root } = args;
  if (amount <= 0n || amount >= AMOUNT_LIMIT) throw new Error("amount out of range");
  const rand = args.randomHex ?? randomSecretHex;
  const tok = String(tokenId);

  const ownerDigest = (await computeRecipientDigest(args.owner)).toString();
  const recipientDigest = (await computeRecipientDigest(args.recipient)).toString();

  // Dummy inputs: value 0, not checked against the root or the owner, but
  // their nullifiers are still recorded on-chain. Fresh random secrets keep
  // them distinct from each other and from every other send.
  const dummySecrets = [hexToDec(rand()), hexToDec(rand())];
  const nullifiers: [string, string] = [
    noteNullifier(dummySecrets[0], 0),
    noteNullifier(dummySecrets[1], 0),
  ];

  const noteSecretHex = rand();
  const changeSecret = hexToDec(rand());
  const secretOut = [hexToDec(noteSecretHex), changeSecret];
  const recipientDigestOut = [recipientDigest, ownerDigest];
  const valueOut = [amount.toString(), "0"];
  const commitments: [string, string] = [
    poseidon([secretOut[0], recipientDigestOut[0], valueOut[0], tok]),
    poseidon([secretOut[1], recipientDigestOut[1], valueOut[1], tok]),
  ];

  const zeros = Array(DEPTH).fill("0");
  const input = {
    root,
    nullifierPub: nullifiers,
    commitmentOutPub: commitments,
    publicDeposit: amount.toString(),
    publicWithdraw: "0",
    tokenId: tok,
    ownerDigest,
    secret: dummySecrets,
    recipientDigest: ["0", "0"],
    value: ["0", "0"],
    leafIndex: ["0", "0"],
    pathElements: [zeros, zeros],
    pathIndices: [zeros, zeros],
    isDummy: ["1", "1"],
    secretOut,
    recipientDigestOut,
    valueOut,
  };

  return {
    input,
    publicSignals: [
      root,
      ...nullifiers,
      ...commitments,
      amount.toString(),
      "0",
      tok,
      ownerDigest,
    ],
    nullifiers,
    commitments,
    ownerDigest,
    note: { secretHex: noteSecretHex, recipientDigest, commitment: commitments[0] },
  };
}
