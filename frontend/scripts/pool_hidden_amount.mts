// Hides the amount, by using the shielded pool's join-split entry point
// (`transact`) instead of the deposit/claim pair.
//
// Why this script exists: `deposit` and `claim` take `amount` as a plaintext
// i128 and the SAC moves exactly that value, so a deposit and its claim show
// the same figure on Stellar Expert and pair on amount alone. `transact` does
// not have to move any value at all: with publicDeposit and publicWithdraw both
// zero, it spends notes and creates notes, and the only numbers on-chain are
// field elements. The amount lives in the Poseidon commitment, where the
// in-circuit balance constraint `sum(in) + deposit == sum(out) + withdraw`
// enforces it without revealing it.
//
// Three steps, which is the whole honest story:
//
//   1. fund     deposit X into the pool.          X is visible. Unavoidable:
//                                                 value has to enter somehow.
//   2. transfer move V to the recipient in-pool.  NOTHING is visible. No
//                                                 amount, no sender, no
//                                                 recipient, no token.
//   3. exit     withdraw V to a wallet.           V is visible, and V != X, so
//                                                 steps 1 and 3 do not pair.
//
// Step 2 is the deliverable's "no visible amount". Steps 1 and 3 are the edges
// of any shielded pool, Zcash included: an observer learns that value entered
// and that value left, never who paid whom or how much changed hands inside.
//
// Run:
//   E2E_SENDER_SECRET=$(stellar keys show zeekpay-bench) \
//   E2E_RECIP_1_SECRET=… npx tsx --env-file=../.env scripts/pool_hidden_amount.mts

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as StellarSdk from "@stellar/stellar-sdk";
// @ts-expect-error - snarkjs has no bundled types.
import * as snarkjs from "snarkjs";
import { poseidon } from "../src/lib/poseidon";
import {
  CONTRACT_ID,
  bytesVal,
  fr,
  g1,
  g2,
  invoke,
  keypairFromEnv,
  localSigner,
  resolveHandle,
  waitForLeaf,
  waitForSpendablePath,
  type MerklePath,
} from "./_e2e_lib.mjs";

const { depositNote } = await import("../src/lib/deposit");

// snarkjs takes filesystem paths here, not URLs.
const WASM = fileURLToPath(
  new URL("../../circuits/build/joinsplit_js/joinsplit.wasm", import.meta.url)
);
const ZKEY = fileURLToPath(new URL("../../circuits/build/joinsplit.zkey", import.meta.url));
const OUT = new URL("./pool_results.json", import.meta.url);

const DEPTH = 20;
const N_IN = 2;
const N_OUT = 2;
const TOKEN_ID = 1; // XLM

/** Amounts in stroops. X funds the pool, V is what actually changes hands.
 *  Deliberately different and deliberately not round: equal values would
 *  re-link the two visible legs and defeat the point of the exercise. */
const X = 123_456_789n; // 12.3456789 XLM in
const V = 77_777_777n; //  7.7777777 XLM to the recipient

const SENDER = keypairFromEnv("E2E_SENDER_SECRET");
const PAYOUT = keypairFromEnv("E2E_RECIP_1_SECRET");

/** A pool note. The commitment is Poseidon([secret, recipientDigest, value,
 *  tokenId]), identical to a `deposit` note, which is why a note created by
 *  `deposit` is spendable by `transact` and both live in one tree. */
interface Note {
  secret: string;
  recipientDigest: string;
  value: bigint;
  /** Set once the indexer has placed it and told us where. */
  leafIndex?: number;
}

const randomFr = (): string => {
  const b = randomBytes(32);
  b[0] = 0; // keep it below the BLS12-381 field order
  return BigInt("0x" + b.toString("hex")).toString();
};

const commit = (n: Note): string =>
  poseidon([n.secret, n.recipientDigest, n.value.toString(), String(TOKEN_ID)]);

const nullifierOf = (n: Note): string => {
  if (n.leafIndex === undefined) throw new Error("note has no leaf index yet");
  // Poseidon([secret, leafIndex]), not Poseidon([secret]) as in claim.circom:
  // binding the position is what stops one secret reused across notes from
  // collapsing them to a single spendable nullifier.
  return poseidon([n.secret, String(n.leafIndex)]);
};

/** A padding input. The circuit skips the membership check when isDummy is 1,
 *  but still constrains leafIndex to equal the index the path's bits describe,
 *  so an all-zero path with leafIndex 0 is the consistent choice. The secret is
 *  random because the contract records every nullifier passed to it, dummies
 *  included, and two dummies sharing a secret would collide. */
const dummy = (): Note => ({ secret: randomFr(), recipientDigest: "0", value: 0n, leafIndex: 0 });
const zeroPath = (): MerklePath => ({
  root: "0",
  pathElements: Array(DEPTH).fill("0"),
  pathIndices: Array(DEPTH).fill(0),
});

interface TransactPlan {
  label: string;
  root: string;
  inputs: { note: Note; path: MerklePath; isDummy: boolean }[];
  outputs: Note[];
  publicDeposit: bigint;
  publicWithdraw: bigint;
  /** Who funds a deposit leg, and who receives a withdrawal leg. Both are
   *  required arguments even when the corresponding leg is zero. */
  depositor: string;
  recipient: string;
}

async function transact(plan: TransactPlan): Promise<string> {
  if (plan.inputs.length !== N_IN || plan.outputs.length !== N_OUT) {
    throw new Error(`${plan.label}: shape must be ${N_IN}-in ${N_OUT}-out`);
  }

  const witness = {
    root: plan.root,
    nullifierPub: plan.inputs.map((i) => nullifierOf(i.note)),
    commitmentOutPub: plan.outputs.map(commit),
    publicDeposit: plan.publicDeposit.toString(),
    publicWithdraw: plan.publicWithdraw.toString(),
    tokenId: String(TOKEN_ID),
    secret: plan.inputs.map((i) => i.note.secret),
    recipientDigest: plan.inputs.map((i) => i.note.recipientDigest),
    value: plan.inputs.map((i) => i.note.value.toString()),
    leafIndex: plan.inputs.map((i) => String(i.note.leafIndex)),
    pathElements: plan.inputs.map((i) => i.path.pathElements),
    pathIndices: plan.inputs.map((i) => i.path.pathIndices),
    isDummy: plan.inputs.map((i) => (i.isDummy ? "1" : "0")),
    secretOut: plan.outputs.map((o) => o.secret),
    recipientDigestOut: plan.outputs.map((o) => o.recipientDigest),
    valueOut: plan.outputs.map((o) => o.value.toString()),
  };

  // The balance constraint the circuit enforces. Checking it here first turns a
  // silent witness-generation failure into a readable error.
  const sumIn = plan.inputs.reduce((a, i) => a + i.note.value, 0n);
  const sumOut = plan.outputs.reduce((a, o) => a + o.value, 0n);
  if (sumIn + plan.publicDeposit !== sumOut + plan.publicWithdraw) {
    throw new Error(
      `${plan.label}: unbalanced, ${sumIn} + ${plan.publicDeposit} != ${sumOut} + ${plan.publicWithdraw}`
    );
  }

  console.log(`    proving ${plan.label}…`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness,
    WASM,
    ZKEY
  );
  // Declared order in joinsplit.circom's main component:
  // [root, nullifierPub[2], commitmentOutPub[2], publicDeposit,
  //  publicWithdraw, tokenId]
  const expected = 1 + N_IN + N_OUT + 3;
  if (publicSignals.length !== expected) {
    throw new Error(
      `unexpected public signal count ${publicSignals.length}, expected ${expected}`
    );
  }

  const proofVal = StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("a"),
      val: bytesVal(g1(proof.pi_a)),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("b"),
      val: bytesVal(g2(proof.pi_b)),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("c"),
      val: bytesVal(g1(proof.pi_c)),
    }),
  ]);

  console.log(`    submitting ${plan.label}…`);
  return invoke(SENDER, "transact", [
    proofVal,
    bytesVal(fr(plan.root)),
    StellarSdk.xdr.ScVal.scvVec(witness.nullifierPub.map((n) => bytesVal(fr(n)))),
    StellarSdk.xdr.ScVal.scvVec(witness.commitmentOutPub.map((c) => bytesVal(fr(c)))),
    StellarSdk.nativeToScVal(plan.publicDeposit, { type: "i128" }),
    StellarSdk.nativeToScVal(plan.publicWithdraw, { type: "i128" }),
    StellarSdk.nativeToScVal(TOKEN_ID, { type: "u32" }),
    StellarSdk.nativeToScVal(plan.depositor, { type: "address" }),
    StellarSdk.nativeToScVal(plan.recipient, { type: "address" }),
  ]);
}

/** The indexer assigns leaf positions, and a note's nullifier depends on its
 *  position, so an output note is not spendable until we learn where it landed.
 *  `/path` is the only thing that knows. */
async function locate(note: Note): Promise<MerklePath> {
  const c = commit(note);
  await waitForLeaf(c);
  const path = await waitForSpendablePath(c, SENDER.publicKey());
  // The path's sibling bits spell out the leaf's index, least-significant first.
  note.leafIndex = path.pathIndices.reduce(
    (acc, bit, k) => acc + (bit ? 2 ** k : 0),
    0
  );
  return path;
}

/** Serialisable form of a note, for the results file. Every note secret is
 *  recorded the moment the note exists, before any transaction that depends on
 *  it: a note whose secret is lost can never be spent, and the value in it is
 *  gone. pool_results.json is gitignored for that reason. */
const noteRecord = (label: string, n: Note) => ({
  label,
  secret: n.secret,
  recipientDigest: n.recipientDigest,
  value: n.value.toString(),
  leafIndex: n.leafIndex ?? null,
  commitment: commit(n),
});

/** POOL_RESUME=1 picks up a run that already moved value. Every note secret and
 *  every transaction hash is on disk, so the steps that completed are skipped
 *  and the ones that did not are retried against the same notes. Re-deriving a
 *  note would change its commitment and abandon the funds in the old one. */
const RESUMING = process.env.POOL_RESUME === "1" && existsSync(OUT);
const prior: Record<string, any> = RESUMING
  ? JSON.parse(readFileSync(OUT, "utf8"))
  : {};
const priorNote = (label: string): Note | undefined => {
  const r = (prior.notes ?? []).find((n: any) => n.label === label);
  if (!r) return undefined;
  return {
    secret: r.secret,
    recipientDigest: r.recipientDigest,
    value: BigInt(r.value),
    leafIndex: r.leafIndex ?? undefined,
  };
};

const results: Record<string, unknown> = {
  ...prior,
  contract: CONTRACT_ID,
  tokenId: TOKEN_ID,
  fundedStroops: X.toString(),
  transferredStroops: V.toString(),
  sender: SENDER.publicKey(),
  payoutWallet: PAYOUT.publicKey(),
};
const flush = () => writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");

// ── step 1: fund the pool. X is visible, and that is expected. ───────────────
const recipient = await resolveHandle(process.env.POOL_HANDLE ?? "github:mdla03");
const { deriveStealthDigest } = await import("../src/lib/stealth");
const senderDigest = randomFr();

const noteA: Note =
  priorNote("A funds the pool") ??
  { secret: randomFr(), recipientDigest: senderDigest, value: X };
const notes = [noteRecord("A funds the pool", noteA)];
results.notes = notes;
flush();

if (prior.fundTx) {
  results.fundTx = prior.fundTx;
  console.log(`[1/3] already funded, reusing ${prior.fundTx}`);
} else {
  console.log(`[1/3] funding the pool with ${X} stroops (visible)`);
  results.fundTx = await depositNote(
    SENDER.publicKey(),
    BigInt(commit(noteA)),
    X,
    localSigner(SENDER),
    TOKEN_ID
  );
  console.log(`    deposit ${results.fundTx}`);
  flush();
}

console.log("    waiting for a posted root that covers it…");
const pathA = await locate(noteA);
notes[0].leafIndex = noteA.leafIndex ?? null;
flush();
console.log(`    note A at leaf ${noteA.leafIndex}, root ${pathA.root.slice(0, 12)}…`);

// ── step 2: the hidden payment. Both public legs are zero. ───────────────────
// Note B is the recipient's, addressed to the stealth digest derived from the
// handle's published key, exactly as a normal send would address it. Note C is
// the sender's change. Neither value appears anywhere on-chain.
const noteB: Note =
  priorNote("B to the recipient") ??
  {
    secret: randomFr(),
    recipientDigest: deriveStealthDigest(recipient.zeekPayPubKey).recipientDigest,
    value: V,
  };
const noteC: Note =
  priorNote("C sender change") ??
  { secret: randomFr(), recipientDigest: senderDigest, value: X - V };
notes.push(noteRecord("B to the recipient", noteB), noteRecord("C sender change", noteC));
flush();

if (prior.hiddenTransferTx) {
  results.hiddenTransferTx = prior.hiddenTransferTx;
  console.log(`[2/3] transfer already done, reusing ${prior.hiddenTransferTx}`);
} else {
console.log(`[2/3] in-pool transfer of ${V} stroops (nothing visible on-chain)`);
results.hiddenTransferTx = await transact({
  label: "in-pool transfer",
  root: pathA.root,
  inputs: [
    { note: noteA, path: pathA, isDummy: false },
    { note: dummy(), path: zeroPath(), isDummy: true },
  ],
  outputs: [noteB, noteC],
  publicDeposit: 0n,
  publicWithdraw: 0n,
  depositor: SENDER.publicKey(),
  recipient: SENDER.publicKey(),
});
console.log(`    transfer ${results.hiddenTransferTx}`);
flush();
}

console.log("    waiting for a posted root that covers note B…");
const pathB = await locate(noteB);
notes[1].leafIndex = noteB.leafIndex ?? null;
flush();
console.log(`    note B at leaf ${noteB.leafIndex}`);

// ── step 3: exit. V is visible, and differs from X. ──────────────────────────
if (prior.withdrawTx) {
  results.withdrawTx = prior.withdrawTx;
  console.log(`[3/3] withdrawal already done, reusing ${prior.withdrawTx}`);
} else {
console.log(`[3/3] withdrawing ${V} stroops to ${PAYOUT.publicKey()}`);
results.withdrawTx = await transact({
  label: "withdrawal",
  root: pathB.root,
  inputs: [
    { note: noteB, path: pathB, isDummy: false },
    { note: dummy(), path: zeroPath(), isDummy: true },
  ],
  outputs: [
    { secret: randomFr(), recipientDigest: "0", value: 0n },
    { secret: randomFr(), recipientDigest: "0", value: 0n },
  ],
  publicDeposit: 0n,
  publicWithdraw: V,
  depositor: SENDER.publicKey(),
  recipient: PAYOUT.publicKey(),
});
console.log(`    withdraw ${results.withdrawTx}`);
flush();
}

console.log(`\nfund     ${results.fundTx}   ${X} stroops visible`);
console.log(`transfer ${results.hiddenTransferTx}   no amount on-chain`);
console.log(`withdraw ${results.withdrawTx}   ${V} stroops visible`);
console.log(`\nResults in ${OUT.pathname}`);
process.exit(0);
