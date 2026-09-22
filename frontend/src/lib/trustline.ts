// Classic Stellar assets (which every Soroban Asset Contract wraps) need an
// explicit trustline before an account can hold them. A claim into a wallet
// that never opted into an asset fails at the SAC with "trustline entry is
// missing for account" (Error(Contract, #13)) even though the claim proof
// itself is fine. This checks for that ahead of time and fixes it.
import * as StellarSdk from "@stellar/stellar-sdk";
import { NATIVE_TOKEN_ID } from "./tokens";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;

// SAC ids for claimable non-native tokens. XLM (NATIVE_TOKEN_ID) is native
// and has no trustline entry, so it's never looked up here.
const TOKEN_SAC: Record<number, string | undefined> = {
  0: process.env.NEXT_PUBLIC_USDC_SAC_ID,
  2: process.env.NEXT_PUBLIC_USDT_SAC_ID,
};

export interface ClaimAsset {
  code: string;
  issuer: string;
}

/** Pure: parse a SEP-41 `name()` response into the asset it names.
 *  "CODE:ISSUER" -> {code, issuer}. "native" -> null, meaning no trustline
 *  is ever needed (short-circuits before any network call). Anything else
 *  is a SAC returning a shape this app doesn't understand, so it throws
 *  rather than silently treating an unparseable name as "no trustline
 *  needed". */
export function parseAssetName(name: string): ClaimAsset | null {
  if (name === "native") return null;
  const [code, issuer] = name.split(":");
  if (!code || !issuer) {
    throw new Error(`Unexpected name() response resolving an asset: ${name}`);
  }
  return { code, issuer };
}

// tokenId -> resolved asset (or null for "confirmed native, no trustline
// needed"). The SAC contract id doesn't carry its classic code/issuer in a
// form we can read off the id itself, but every SAC implements SEP-41's
// name(), which returns "CODE:ISSUER" for a classic asset ("native" for
// XLM). Resolved once per token id per page load and cached here rather than
// simulated on every claim.
const assetCache = new Map<number, ClaimAsset | null>();

async function resolveAssetForToken(
  tokenId: number,
  connectedAddress: string
): Promise<ClaimAsset | undefined> {
  const cached = assetCache.get(tokenId);
  if (cached !== undefined) return cached ?? undefined;

  const sacId = TOKEN_SAC[tokenId];
  if (!sacId) {
    throw new Error(
      `Can't add a trustline automatically: no SAC id configured for token ${tokenId}. ` +
        `Set NEXT_PUBLIC_USDC_SAC_ID / NEXT_PUBLIC_USDT_SAC_ID.`
    );
  }

  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  // A throwaway account object, used only to shape a simulate-only
  // transaction. Never built into anything submitted, so its local sequence
  // number (TransactionBuilder mutates it) never needs to match on-chain
  // state, and there's no need to round-trip to the RPC for the real one.
  const simAccount = new StellarSdk.Account(connectedAddress, "0");
  const contract = new StellarSdk.Contract(sacId);
  const tx = new StellarSdk.TransactionBuilder(simAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("name"))
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Couldn't resolve the asset for token ${tokenId}: ${sim.error}`);
  }
  const name = StellarSdk.scValToNative(sim.result!.retval) as string;

  const asset = parseAssetName(name);
  assetCache.set(tokenId, asset);
  return asset ?? undefined;
}

/** Does `connectedAddress` already have a trustline for `asset`, per the
 *  Soroban RPC's ledger entry read? A missing entry means changeTrust is
 *  still needed. */
async function hasTrustline(
  rpc: InstanceType<typeof StellarSdk.rpc.Server>,
  connectedAddress: string,
  asset: ClaimAsset
): Promise<boolean> {
  const trustAsset = new StellarSdk.Asset(asset.code, asset.issuer);
  const key = StellarSdk.xdr.LedgerKey.trustline(
    new StellarSdk.xdr.LedgerKeyTrustLine({
      accountId: StellarSdk.Keypair.fromPublicKey(connectedAddress).xdrAccountId(),
      asset: trustAsset.toTrustLineXDRObject(),
    })
  );
  const response = await rpc.getLedgerEntries(key);
  return response.entries.length > 0;
}

/**
 * Before a claim can land, the connected wallet needs a trustline for
 * non-native claim assets. No-op when the trustline is already open (checked
 * via the Soroban RPC's ledger entries) or the asset is native. Otherwise
 * builds a changeTrust operation, has the wallet sign it (reuses the same
 * `signTx` the claim itself signs with), submits it, and waits for it to
 * land before returning.
 *
 * ponytail: one-time cost per asset per wallet. After the first claim of a
 * given token the account already trusts it and this returns immediately.
 */
export async function ensureTrustline(
  tokenId: number,
  connectedAddress: string,
  signTx: (xdr: string) => Promise<string>,
  onStatus?: (label: string) => void
): Promise<void> {
  if (tokenId === NATIVE_TOKEN_ID) return;

  const asset = await resolveAssetForToken(tokenId, connectedAddress);
  if (!asset) return; // SAC reports native; nothing to trust.

  const rpc = new StellarSdk.rpc.Server(RPC_URL);
  if (await hasTrustline(rpc, connectedAddress, asset)) return;

  onStatus?.(`Adding ${asset.code} to your wallet`);

  const account = await rpc.getAccount(connectedAddress);
  const trustAsset = new StellarSdk.Asset(asset.code, asset.issuer);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset: trustAsset }))
    .setTimeout(60)
    .build();

  const signedXdr = await signTx(tx.toXDR());
  const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  const result = await rpc.sendTransaction(signedTx);
  if (result.status === "ERROR") {
    throw new Error(`Adding the trustline failed: ${JSON.stringify(result.errorResult)}`);
  }

  const final = await rpc.pollTransaction(result.hash, { attempts: 30 });
  if (final.status !== "SUCCESS") {
    throw new Error(`Adding the trustline ended with status: ${final.status}`);
  }
}
