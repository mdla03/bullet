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
import { buildClaimOperation } from "./claim_encode";
import { ensureTrustline } from "./trustline";
import { TOKEN_SAC } from "./tokens";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;

/**
 * Claim an invite: contract.claim(recipient=custody) + token.transfer(custody
 * -> user real wallet). One tx, custody wallet signs both.
 * Returns the tx hash.
 */
/**
 * Claim an invite note and forward tokens to the user's real wallet.
 * `amount` is the raw stroop value (e.g. 100_000_000n for 10 USDC).
 * `tokenId` identifies the token (0 = USDC, 1 = XLM).
 * `amountCommitmentX`/`amountCommitmentY` are the 64-char hex (32-byte BE) Fr
 * coordinates of the Pedersen amount commitment (publicSignals[5]/[6] from
 * the claim circuit), concatenated BE(X) || BE(Y) into the contract's
 * 64-byte `amount_commitment` argument.
 * `signTx` signs on behalf of `userRealWallet` (e.g. via Freighter): the
 * custody keypair signs both on-chain txs, but the forward's destination
 * trustline (if one is needed) can only be opened by the account it belongs
 * to, so that one step needs the user's own wallet signature.
 * `inviteId` is the pending_invites row id (note.inviteId), used only to
 * tell the backend which row to stamp claimed_at on once TX B lands.
 */
export async function claimInvite(
  inviteId: string,
  custodyStellarSecret: string,
  userRealWallet: string,
  proofA: string,
  proofB: string,
  proofC: string,
  root: string,
  nullifier: string,
  recipientDigest: string,
  amount: bigint,
  tokenId: number,
  amountCommitmentX: string,
  amountCommitmentY: string,
  signTx: (xdr: string) => Promise<string>,
  onStatus?: (label: string) => void
): Promise<string> {
  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  const custody = StellarSdk.Keypair.fromSecret(custodyStellarSecret);
  const custodyAddr = custody.publicKey();

  const contract = new StellarSdk.Contract(CONTRACT_ID);

  // TX A: contract.claim, USDC lands in the custody wallet.
  const claimOp = buildClaimOperation(contract, {
    proofA,
    proofB,
    proofC,
    root,
    nullifier,
    recipientDigest,
    recipient: custodyAddr,
    amount,
    tokenId,
    amountCommitmentX,
    amountCommitmentY,
  });
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

  // TX B: forward tokens from custody to the recipient's real wallet. Same
  // trustline exposure as the direct claim path (claim_tx.ts's claimNote):
  // a non-native transfer into a wallet that never opted into the asset
  // fails at the SAC with "trustline entry is missing", so open it first.
  await ensureTrustline(tokenId, userRealWallet, signTx, onStatus);

  const sacAddr = TOKEN_SAC[tokenId] ?? TOKEN_SAC[0];
  const tokenContract = new StellarSdk.Contract(sacAddr);
  const transferOp = tokenContract.call(
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

  // Stamp pending_invites.claimed_at now, at the moment the custody-forward
  // transfer actually succeeds, instead of relying only on the separate,
  // later markClaimed(note.id) call in Inbox.tsx (which cascades to this
  // same row via notes.invite_id, but is itself best-effort and can be
  // skipped, e.g. if the tab closes right after this resolves).
  try {
    const { apiFetch } = await import("./api");
    await apiFetch("/invite/mark-claimed", {
      method: "POST",
      body: JSON.stringify({ inviteId }),
    });
  } catch {
    // Best-effort. The on-chain transfer (resB.hash) is the real record.
  }

  return resA.hash;
}
