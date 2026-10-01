// Read-only token balance for the send form. Simulates the token's SAC
// balance(address) call (no signature, no fee, no submission). Callers treat
// any failure as "unknown" and do not block the send.

import * as StellarSdk from "@stellar/stellar-sdk";
import { TOKEN_SAC } from "./tokens";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;

const rpc = new StellarSdk.rpc.Server(RPC_URL);

/** Balance of `address` in base units (7 decimals), or null if it can't be read. */
export async function fetchTokenBalance(
  tokenId: number,
  address: string
): Promise<bigint | null> {
  const sac = TOKEN_SAC[tokenId];
  if (!sac) return null;
  try {
    // Simulation does not check the sequence number, so no account lookup.
    const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(address, "0"), {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        new StellarSdk.Contract(sac).call("balance", new StellarSdk.Address(address).toScVal())
      )
      .setTimeout(30)
      .build();
    const sim = await rpc.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(sim) || !sim.result) return null;
    return BigInt(StellarSdk.scValToNative(sim.result.retval));
  } catch {
    return null;
  }
}
