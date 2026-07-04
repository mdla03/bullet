// Claim path for INVITE notes.
//
// Deposits for invites are bound to a per-invite custody Stellar wallet, not
// to the recipient's real wallet. So the recipient's browser:
//   1. Runs the same browser Groth16 prover (recipientDigest = sha256(custody)).
//   2. TX A: contract.claim signed by the custody keypair. Contract sends
//      USDC to the custody wallet.
//   3. TX B: SAC transfer signed by the custody keypair. Custody wallet sends
//      USDC to the recipient's real wallet.
//
// The two ops must be SEPARATE Stellar txs because Soroban only allows ONE
// InvokeHostFunction per transaction. Not atomic on-chain, but only the
// recipient (holder of the custody secret) can execute step 3, so no race
// window that an attacker can exploit.

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

  // TX A: contract.claim, USDC lands in the custody wallet.
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
  const acctA = await rpc.getAccount(custodyAddr);
  const txA = new StellarSdk.TransactionBuilder(acctA, {
    fee: "2000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(claimOp)
    .setTimeout(60)
    .build();
  const preparedA = await rpc.prepareTransaction(txA);
  preparedA.sign(custody);
  const resA = await rpc.sendTransaction(preparedA);
  if (resA.status === "ERROR") {
    throw new Error(`invite claim failed: ${JSON.stringify(resA.errorResult)}`);
  }
  const finalA = await rpc.pollTransaction(resA.hash, { attempts: 30 });
  if (finalA.status !== "SUCCESS") {
    throw new Error(`invite claim ended with status: ${finalA.status}`);
  }

  // TX B: forward USDC from custody to the recipient's real wallet.
  const amount = BigInt(denom) * USDC_DECIMALS;
  const transferOp = usdcContract.call(
    "transfer",
    StellarSdk.nativeToScVal(custodyAddr, { type: "address" }),
    StellarSdk.nativeToScVal(userRealWallet, { type: "address" }),
    StellarSdk.nativeToScVal(amount, { type: "i128" })
  );
  const acctB = await rpc.getAccount(custodyAddr);
  const txB = new StellarSdk.TransactionBuilder(acctB, {
    fee: "2000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(transferOp)
    .setTimeout(60)
    .build();
  const preparedB = await rpc.prepareTransaction(txB);
  preparedB.sign(custody);
  const resB = await rpc.sendTransaction(preparedB);
  if (resB.status === "ERROR") {
    throw new Error(`invite forward failed: ${JSON.stringify(resB.errorResult)}`);
  }
  const finalB = await rpc.pollTransaction(resB.hash, { attempts: 30 });
  if (finalB.status !== "SUCCESS") {
    throw new Error(`invite forward ended with status: ${finalB.status}`);
  }
  return resA.hash;
}
