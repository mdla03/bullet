import * as StellarSdk from "@stellar/stellar-sdk";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ??
  StellarSdk.Networks.TESTNET;

/** Convert a bigint commitment to a 32-byte big-endian Uint8Array. */
function bigIntToBytes32BE(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Build, prepare, sign (via Freighter), and submit a deposit transaction.
 * Returns the transaction hash on success.
 * `amount` is the raw stroop value (e.g. 100_000_000n for 10 USDC).
 * `tokenId` identifies the token (0 = USDC, 1 = XLM).
 */
export async function depositNote(
  senderAddress: string,
  commitment: bigint,
  amount: bigint,
  signTx: (xdr: string) => Promise<string>,
  tokenId: number = 0
): Promise<string> {
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const { xdr } = StellarSdk;

  const amountVal = StellarSdk.nativeToScVal(amount, { type: "i128" });
  const commitmentVal = xdr.ScVal.scvBytes(
    Buffer.from(bigIntToBytes32BE(commitment))
  );
  const fromVal = StellarSdk.nativeToScVal(senderAddress, { type: "address" });
  const tokenIdVal = StellarSdk.nativeToScVal(tokenId, { type: "u32" });

  const operation = contract.call("deposit", fromVal, amountVal, commitmentVal, tokenIdVal);

  const account = await rpc.getAccount(senderAddress);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  const signedXdr = await signTx(prepared.toXDR());
  const signedTx = StellarSdk.TransactionBuilder.fromXDR(
    signedXdr,
    NETWORK_PASSPHRASE
  );

  const result = await rpc.sendTransaction(signedTx);
  if (result.status === "ERROR") {
    throw new Error(`deposit failed: ${JSON.stringify(result.errorResult)}`);
  }
  // Poll to confirmation (L4): a submitted-but-not-yet-final deposit must not be
  // reported as success. The indexer also only picks up confirmed deposits.
  const final = await rpc.pollTransaction(result.hash, { attempts: 30 });
  if (final.status !== "SUCCESS") {
    throw new Error(`deposit tx ended with status: ${final.status}`);
  }
  return result.hash;
}
