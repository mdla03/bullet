// Claim path for INVITE notes.
//
// Deposits for invites are bound to a per-invite custody Stellar wallet, not
// to the recipient's real wallet. So the recipient's browser:
//   1. Runs the same browser Groth16 prover (recipientDigest = sha256(custody)).
//   2. Signs the claim tx with the custody wallet's private key (not Freighter).
//      That tx has the custody wallet claim the note (contract sends USDC to
//      the custody wallet) AND immediately transfer the USDC to the recipient's
//      real wallet, in a single atomic tx.
//
// After this succeeds, the custody wallet holds no USDC — its only remaining
// balance is the leftover XLM used for base reserve + fees. Sweeping that back
// to a master wallet is deferred to a background cleanup script.

import * as StellarSdk from "@stellar/stellar-sdk";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const USDC_SAC = process.env.NEXT_PUBLIC_USDC_SAC_ID ?? "";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;

const DENOM_VARIANT: Record<number, string> = {
  1: "One",
  10: "Ten",
  50: "Fifty",
  100: "Hundred",
};

const USDC_DECIMALS = 10_000_000n; // 7 decimals on Stellar

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

/**
 * Claim an invite: contract.claim(recipient=custody) + token.transfer(custody
 * -> user real wallet). One tx, custody wallet signs both.
 * Returns the tx hash.
 */
export async function claimInvite(
  custodyStellarSecret: string,
  userRealWallet: string,
  proofA: string,
  proofB: string,
  proofC: string,
  root: string,
  nullifier: string,
  denom: 1 | 10 | 50 | 100
): Promise<string> {
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const custody = StellarSdk.Keypair.fromSecret(custodyStellarSecret);
  const custodyAddr = custody.publicKey();

  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const usdcContract = new StellarSdk.Contract(USDC_SAC);
  const { xdr } = StellarSdk;

  const claimOp = contract.call(
    "claim",
    xdr.ScVal.scvBytes(hexToBuffer(proofA)),
    xdr.ScVal.scvBytes(hexToBuffer(proofB)),
    xdr.ScVal.scvBytes(hexToBuffer(proofC)),
    xdr.ScVal.scvBytes(hexToBuffer(root)),
    xdr.ScVal.scvBytes(hexToBuffer(nullifier)),
    StellarSdk.nativeToScVal(custodyAddr, { type: "address" }),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(DENOM_VARIANT[denom])])
  );

  // Forward USDC from the custody wallet to the recipient's real wallet.
  const amount = BigInt(denom) * USDC_DECIMALS;
  const transferOp = usdcContract.call(
    "transfer",
    StellarSdk.nativeToScVal(custodyAddr, { type: "address" }),
    StellarSdk.nativeToScVal(userRealWallet, { type: "address" }),
    StellarSdk.nativeToScVal(amount, { type: "i128" })
  );

  const account = await rpc.getAccount(custodyAddr);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "2000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(claimOp)
    .addOperation(transferOp)
    .setTimeout(60)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(custody);

  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw new Error(`invite claim failed: ${JSON.stringify(result.errorResult)}`);
  }
  const final = await rpc.pollTransaction(result.hash, { attempts: 30 });
  if (final.status !== "SUCCESS") {
    throw new Error(`invite claim ended with status: ${final.status}`);
  }
  return result.hash;
}
