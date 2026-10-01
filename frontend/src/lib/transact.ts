import * as StellarSdk from "@stellar/stellar-sdk";
import { buildSendWitness } from "./joinsplit";
import { proveSend, type SendProof } from "./prove_browser";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;
const RESOLVER_URL = process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";

const dec32 = (d: string) => Buffer.from(BigInt(d).toString(16).padStart(64, "0"), "hex");
const bytes = (d: string) => StellarSdk.xdr.ScVal.scvBytes(dec32(d));

/** A root the contract has accepted. transact rejects any other, even when
 *  every input is a dummy. */
async function fetchKnownRoot(): Promise<string> {
  const res = await fetch(`${RESOLVER_URL}/root`);
  if (!res.ok) throw new Error(`Couldn't fetch the pool root (${res.status}). Try again in a moment.`);
  const { root } = (await res.json()) as { root?: string };
  if (!root || !/^\d+$/.test(root)) throw new Error("The resolver returned no pool root.");
  return root;
}

/** ProofBytes { a, b, c } as the ScMap soroban-sdk expects for a contracttype
 *  struct: symbol keys in sorted order. */
function proofScVal(p: SendProof): StellarSdk.xdr.ScVal {
  const { xdr } = StellarSdk;
  const entry = (k: string, hex: string) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: xdr.ScVal.scvBytes(Buffer.from(hex, "hex")) });
  return xdr.ScVal.scvMap([entry("a", p.proof_a), entry("b", p.proof_b), entry("c", p.proof_c)]);
}

/**
 * Send `amount` stroops of `tokenId` to `recipient` as a shielded note:
 * prove a join-split with two dummy inputs and publicDeposit = amount, then
 * call transact(proof, root, nullifiers, out_commitments, public_deposit,
 * public_withdraw, token_id, depositor, recipient, owner) with the sender as
 * owner and depositor. The note is addressed to `recipient`'s digest, so only
 * that address can claim it.
 *
 * Returns the tx hash and the note the recipient needs (secret and digest),
 * which the caller turns into a claim link and inbox note.
 */
export async function sendNote(args: {
  sender: string;
  recipient: string;
  amount: bigint;
  tokenId: number;
  signTx: (xdr: string) => Promise<string>;
  onStage?: (stage: "proving" | "signing") => void;
}): Promise<{ hash: string; secretHex: string; recipientDigest: string }> {
  const { sender, recipient, amount, tokenId, signTx, onStage } = args;

  onStage?.("proving");
  const root = await fetchKnownRoot();
  const w = await buildSendWitness({ owner: sender, recipient, amount, tokenId, root });
  const proof = await proveSend(w.input, w.publicSignals);

  onStage?.("signing");
  const { xdr } = StellarSdk;
  const addr = (a: string) => StellarSdk.nativeToScVal(a, { type: "address" });
  const op = new StellarSdk.Contract(CONTRACT_ID).call(
    "transact",
    proofScVal(proof),
    bytes(root),
    xdr.ScVal.scvVec(w.nullifiers.map(bytes)),
    xdr.ScVal.scvVec(w.commitments.map(bytes)),
    StellarSdk.nativeToScVal(amount, { type: "i128" }),
    StellarSdk.nativeToScVal(0n, { type: "i128" }),
    StellarSdk.nativeToScVal(tokenId, { type: "u32" }),
    addr(sender), // depositor
    addr(sender), // recipient of public_withdraw, which is 0 for a send
    addr(sender) // owner
  );

  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const account = await rpc.getAccount(sender);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  const signedXdr = await signTx(prepared.toXDR());
  const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  const result = await rpc.sendTransaction(signedTx);
  if (result.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(result.errorResult)}`);
  }
  // A submitted but unconfirmed send must not be reported as success, and the
  // indexer only picks up confirmed notes.
  const final = await rpc.pollTransaction(result.hash, { attempts: 30 });
  if (final.status !== "SUCCESS") {
    throw new Error(`send tx ended with status: ${final.status}`);
  }
  return { hash: result.hash, secretHex: w.note.secretHex, recipientDigest: w.note.recipientDigest };
}
