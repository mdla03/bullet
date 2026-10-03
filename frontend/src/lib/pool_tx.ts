// Browser-side shielded-pool spends: build, prove, sign (via Freighter) and
// submit a `transact` call. This is the UI's wrapper around the join-split path
// that frontend/scripts/pool_hidden_amount.mts proved end-to-end on testnet.
// The proof is generated locally from /circuits/joinsplit.{wasm,zkey}, so the
// note secrets never leave the tab.
//
// One entry point, `transact`, covers every shape: a fund sets publicDeposit
// and dummy inputs, a withdraw sets publicWithdraw, an in-pool transfer leaves
// both public legs zero. Callers build a plan; this proves and submits it.

import * as StellarSdk from "@stellar/stellar-sdk";
// @ts-expect-error — snarkjs has no bundled types.
import * as snarkjs from "snarkjs";
import {
  POOL_DEPTH,
  POOL_N_IN,
  POOL_N_OUT,
  isBalanced,
  noteCommitment,
  noteNullifier,
  type PoolNote,
} from "./pool_note";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;
// Site-relative in the browser (snarkjs fetches them). Overridable so a Node
// harness can point snarkjs at local files, which it opens directly rather than
// over fetch. Unset in production => the defaults below.
const WASM_URL = process.env.NEXT_PUBLIC_JOINSPLIT_WASM || "/circuits/joinsplit.wasm";
const ZKEY_URL = process.env.NEXT_PUBLIC_JOINSPLIT_ZKEY || "/circuits/joinsplit.zkey";

/** A Merkle path as the resolver's /path returns it (root/elements decimal). */
export interface PoolPath {
  root: string;
  pathElements: string[];
  pathIndices: number[];
}

/** One input leg: a real note with its membership path, or a dummy. A dummy
 *  contributes nothing and skips the membership check in-circuit, but still
 *  needs a zero path and a secret (its nullifier is recorded like any other). */
export interface PoolInput {
  note: PoolNote;
  path: PoolPath;
  isDummy: boolean;
}

export interface TransactPlan {
  inputs: PoolInput[];
  outputs: PoolNote[];
  publicDeposit: bigint;
  publicWithdraw: bigint;
  /** The root every real input proves against; also the contract argument. */
  root: string;
  /** Funds a deposit leg (required even when publicDeposit is 0). */
  depositor: string;
  /** Receives a withdrawal leg (required even when publicWithdraw is 0). */
  recipient: string;
}

const be = (dec: string, bytes: number): string => {
  const h = BigInt(dec).toString(16);
  if (h.length > bytes * 2) throw new Error(`value overflow: ${dec}`);
  return h.padStart(bytes * 2, "0");
};
const g1 = (pt: [string, string, string]): string => be(pt[0], 48) + be(pt[1], 48);
const g2 = (pt: [[string, string], [string, string], [string, string]]): string =>
  be(pt[0][1], 48) + be(pt[0][0], 48) + be(pt[1][1], 48) + be(pt[1][0], 48);
const fr = (dec: string): string => be(dec, 32);
const bytesVal = (hex: string) => StellarSdk.xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

const ZERO_PATH: PoolPath = {
  root: "0",
  pathElements: Array(POOL_DEPTH).fill("0"),
  pathIndices: Array(POOL_DEPTH).fill(0),
};

/** A padding input: contributes no value, skips membership. Its secret is
 *  random so the nullifier it records never collides with a real note's. */
export function dummyInput(): PoolInput {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  b[0] = 0; // keep below the field order
  const secret = BigInt(
    "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")
  ).toString();
  return {
    note: { secret, recipientDigest: "0", value: 0n, tokenId: 0, leafIndex: 0 },
    path: ZERO_PATH,
    isDummy: true,
  };
}

/** Build the join-split witness, prove it locally, and return the Soroban
 *  `transact` arguments. Pure except for loading the circuit assets. */
async function proveTransact(plan: TransactPlan) {
  if (plan.inputs.length !== POOL_N_IN || plan.outputs.length !== POOL_N_OUT) {
    throw new Error(`pool shape must be ${POOL_N_IN}-in ${POOL_N_OUT}-out`);
  }
  if (!isBalanced(plan.inputs.map((i) => i.note), plan.outputs, plan.publicDeposit, plan.publicWithdraw)) {
    throw new Error("join-split is unbalanced: inputs + deposit != outputs + withdraw");
  }
  const tokenId = plan.outputs[0]?.tokenId ?? plan.inputs[0].note.tokenId;

  const witness = {
    root: plan.root,
    nullifierPub: plan.inputs.map((i) => noteNullifier(i.note)),
    commitmentOutPub: plan.outputs.map(noteCommitment),
    publicDeposit: plan.publicDeposit.toString(),
    publicWithdraw: plan.publicWithdraw.toString(),
    tokenId: String(tokenId),
    secret: plan.inputs.map((i) => i.note.secret),
    recipientDigest: plan.inputs.map((i) => i.note.recipientDigest),
    value: plan.inputs.map((i) => i.note.value.toString()),
    leafIndex: plan.inputs.map((i) => String(i.note.leafIndex ?? 0)),
    pathElements: plan.inputs.map((i) => i.path.pathElements),
    pathIndices: plan.inputs.map((i) => i.path.pathIndices),
    isDummy: plan.inputs.map((i) => (i.isDummy ? "1" : "0")),
    secretOut: plan.outputs.map((o) => o.secret),
    recipientDigestOut: plan.outputs.map((o) => o.recipientDigest),
    valueOut: plan.outputs.map((o) => o.value.toString()),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness,
    WASM_URL,
    ZKEY_URL
  );
  const expected = 1 + POOL_N_IN + POOL_N_OUT + 3;
  if (publicSignals.length !== expected) {
    throw new Error(
      `unexpected public signal count ${publicSignals.length} (expected ${expected}; served joinsplit assets may be stale)`
    );
  }

  const proofVal = StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({ key: StellarSdk.xdr.ScVal.scvSymbol("a"), val: bytesVal(g1(proof.pi_a)) }),
    new StellarSdk.xdr.ScMapEntry({ key: StellarSdk.xdr.ScVal.scvSymbol("b"), val: bytesVal(g2(proof.pi_b)) }),
    new StellarSdk.xdr.ScMapEntry({ key: StellarSdk.xdr.ScVal.scvSymbol("c"), val: bytesVal(g1(proof.pi_c)) }),
  ]);

  return [
    proofVal,
    bytesVal(fr(plan.root)),
    StellarSdk.xdr.ScVal.scvVec(witness.nullifierPub.map((n) => bytesVal(fr(n)))),
    StellarSdk.xdr.ScVal.scvVec(witness.commitmentOutPub.map((c) => bytesVal(fr(c)))),
    StellarSdk.nativeToScVal(plan.publicDeposit, { type: "i128" }),
    StellarSdk.nativeToScVal(plan.publicWithdraw, { type: "i128" }),
    StellarSdk.nativeToScVal(tokenId, { type: "u32" }),
    StellarSdk.nativeToScVal(plan.depositor, { type: "address" }),
    StellarSdk.nativeToScVal(plan.recipient, { type: "address" }),
  ];
}

/**
 * Prove, sign (via the Freighter callback) and submit a `transact`. Returns the
 * transaction hash on SUCCESS. `signerAddress` is the account that signs: the
 * depositor on a fund (it authorises the pulled balance) or any connected
 * account on a transfer/withdraw.
 */
export async function submitTransact(
  signerAddress: string,
  plan: TransactPlan,
  signTx: (xdr: string) => Promise<string>,
  onStatus?: (label: string) => void
): Promise<string> {
  onStatus?.("Proving");
  const args = await proveTransact(plan);

  onStatus?.("Signing");
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const account = await rpc.getAccount(signerAddress);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "2000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("transact", ...args))
    .setTimeout(60)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  const signedXdr = await signTx(prepared.toXDR());
  const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  onStatus?.("Submitting");
  const result = await rpc.sendTransaction(signedTx);
  if (result.status === "ERROR") {
    throw new Error(`transact failed: ${JSON.stringify(result.errorResult)}`);
  }
  const final = await rpc.pollTransaction(result.hash, { attempts: 30 });
  if (final.status !== "SUCCESS") {
    throw new Error(`transact ended with status: ${final.status}`);
  }
  return result.hash;
}
