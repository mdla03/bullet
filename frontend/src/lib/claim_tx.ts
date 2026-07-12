import * as StellarSdk from "@stellar/stellar-sdk";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

/**
 * Build, sign (via Freighter callback), submit, and poll the Soroban
 * claim(proof_a, proof_b, proof_c, root, nullifier, recipient_digest, recipient, amount) tx.
 * `amount` is the raw stroop value (e.g. 100_000_000n for 10 USDC).
 * `recipientDigest` is the 64-char hex (32-byte BE) passed explicitly to the contract.
 * Returns the transaction hash on SUCCESS.
 */
export async function claimNote(
  connectedAddress: string,
  proofA: string,
  proofB: string,
  proofC: string,
  root: string,
  nullifier: string,
  recipientDigest: string,
  amount: bigint,
  signTx: (xdr: string) => Promise<string>
): Promise<string> {
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const { xdr } = StellarSdk;

  const proofAVal = xdr.ScVal.scvBytes(hexToBuffer(proofA));
  const proofBVal = xdr.ScVal.scvBytes(hexToBuffer(proofB));
  const proofCVal = xdr.ScVal.scvBytes(hexToBuffer(proofC));
  const rootVal = xdr.ScVal.scvBytes(hexToBuffer(root));
  const nullifierVal = xdr.ScVal.scvBytes(hexToBuffer(nullifier));
  const recipientDigestVal = xdr.ScVal.scvBytes(hexToBuffer(recipientDigest));
  const recipientVal = StellarSdk.nativeToScVal(connectedAddress, { type: "address" });
  const amountVal = StellarSdk.nativeToScVal(amount, { type: "i128" });

  const operation = contract.call(
    "claim",
    proofAVal,
    proofBVal,
    proofCVal,
    rootVal,
    nullifierVal,
    recipientDigestVal,
    recipientVal,
    amountVal
  );

  const account = await rpc.getAccount(connectedAddress);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  const signedXdr = await signTx(prepared.toXDR());
  const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  const result = await rpc.sendTransaction(signedTx);
  if (result.status === "ERROR") {
    throw new Error(`claim failed: ${JSON.stringify(result.errorResult)}`);
  }

  const final = await rpc.pollTransaction(result.hash, { attempts: 30 });
  if (final.status !== "SUCCESS") {
    throw new Error(`claim tx ended with status: ${final.status}`);
  }

  return result.hash;
}
