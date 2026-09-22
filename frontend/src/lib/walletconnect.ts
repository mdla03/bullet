// WalletConnect v2 transport, used only inside Freighter's mobile in-app
// browser. The mobile app has no content script, so @stellar/freighter-api
// (which talks to the extension over window.postMessage) can never work there.
// Freighter mobile speaks the `stellar` namespace over a WalletConnect relay
// instead. This mirrors the Freighter team's own reference dapp at
// stellar/freighter-mobile:mock-dapp/src/walletconnect.ts, which uses
// @walletconnect/sign-client directly. No modal: we already know the wallet is
// Freighter, so there is nothing to pick from a wallet list.

import { Keypair, Networks, hash } from "@stellar/stellar-base";
import type SignClient from "@walletconnect/sign-client";

// @walletconnect/types is only a transitive dep, so derive the session shape
// from sign-client rather than depending on it directly.
type WcSession = ReturnType<SignClient["session"]["getAll"]>[number];

const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? Networks.TESTNET;

/** Freighter mobile validates this against its own active network and rejects a mismatch. */
function chainFor(passphrase: string): string {
  return passphrase === Networks.PUBLIC ? "stellar:pubnet" : "stellar:testnet";
}

const CHAIN_ID = chainFor(NETWORK_PASSPHRASE);

const METHODS = [
  "stellar_signMessage",
  "stellar_signXDR",
  "stellar_signAndSubmitXDR",
  "stellar_signAuthEntry",
];

/** How long the user gets to approve in the wallet before we give up. */
const APPROVAL_TIMEOUT_MS = 120_000;

function projectId(): string {
  const id = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  if (!id)
    throw new Error(
      "Wallet connections from the Freighter app aren't configured on this deployment. Open Bullet in a desktop browser with the Freighter extension."
    );
  return id;
}

let clientPromise: Promise<SignClient> | null = null;

function getClient(): Promise<SignClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      // Named export, not default: sign-client ships both an ESM and a CJS
      // build, and under CJS interop the default import is the whole module
      // namespace (no .init on it). `SignClient` is the class either way.
      const { SignClient: Client } = await import("@walletconnect/sign-client");
      return Client.init({
        projectId: projectId(),
        metadata: {
          name: "Bullet",
          description: "Private payments on Stellar.",
          url: window.location.origin,
          icons: [`${window.location.origin}/logomark.svg`],
        },
      });
    })().catch((e) => {
      // A failed init must not poison every later attempt.
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

/** Most recent unexpired session, or null. sign-client persists these itself. */
function liveSession(client: SignClient): WcSession | null {
  const now = Math.floor(Date.now() / 1000);
  const sessions = client.session
    .getAll()
    .filter((s) => s.expiry > now && s.namespaces.stellar);
  return sessions.length ? sessions[sessions.length - 1] : null;
}

/** Accounts look like "stellar:testnet:G...". */
function addressOf(session: WcSession): string {
  const account = session.namespaces.stellar?.accounts?.[0];
  const address = account?.split(":")[2];
  if (!address) throw new Error("Freighter returned no account.");
  return address;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/**
 * Hand the pairing URI to the Freighter app.
 *
 * This exact string matters. Freighter's deep-link handler
 * (freighter-mobile src/hooks/useWalletKitEventsManager.ts) is:
 *
 *   if (!event.url?.includes(WALLET_KIT_MT_REDIRECT_NATIVE)) return;
 *   const uriParam = new URL(event.url).search.split("uri=")[1];
 *   walletKit.pair({ uri: decodeURIComponent(uriParam) });
 *
 * so the URL has to *contain* the wallet's registered native link and carry
 * the pairing uri in the query string. Anything else is dropped silently:
 * the generic `wc?uri=` convention does not match, which is why connecting
 * failed at the approval timeout with no prompt on the phone.
 *
 * WALLET_KIT_MT_REDIRECT_NATIVE is not in their repo (it comes from CI env),
 * but it is published in the WalletConnect wallet registry as Freighter's
 * mobile.native link, which is the value AppKit itself deep-links to:
 *   explorer-api.walletconnect.com/v3/wallets?search=freighter
 *   -> mobile: { native: "freighterwallet://wc-redirect" }
 */
const FREIGHTER_NATIVE_LINK = "freighterwallet://wc-redirect";

export function freighterDeepLink(uri: string): string {
  return `${FREIGHTER_NATIVE_LINK}?uri=${encodeURIComponent(uri)}`;
}

function openWallet(uri: string) {
  window.location.href = freighterDeepLink(uri);
}

/** Connect (or reuse a live session) and return the Stellar address. */
export async function wcConnect(): Promise<string> {
  const client = await getClient();

  const existing = liveSession(client);
  if (existing) return addressOf(existing);

  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      stellar: {
        methods: METHODS,
        chains: [CHAIN_ID],
        events: ["accountsChanged"],
      },
    },
  });
  if (!uri) throw new Error("Couldn't start a Freighter connection.");

  openWallet(uri);
  const session = await withTimeout(
    approval(),
    APPROVAL_TIMEOUT_MS,
    "Freighter didn't confirm the connection. Open the Freighter app, approve the request, and try again."
  );
  return addressOf(session);
}

async function request<T>(
  method: string,
  params: Record<string, unknown>,
  chainId: string = CHAIN_ID
): Promise<T> {
  const client = await getClient();
  const session = liveSession(client);
  if (!session) throw new Error("Freighter isn't connected. Connect your wallet and try again.");
  return client.request<T>({
    topic: session.topic,
    chainId,
    request: { method, params },
  });
}

export async function wcSignTransaction(
  xdr: string,
  networkPassphrase: string
): Promise<string> {
  const res = await request<{ signedXDR: string }>(
    "stellar_signXDR",
    { xdr },
    chainFor(networkPassphrase)
  );
  if (!res?.signedXDR) throw new Error("Freighter returned no signed transaction.");
  return res.signedXDR;
}

/**
 * SEP-53: the signature covers sha256("Stellar Signed Message:\n" + message),
 * NOT the raw message bytes. Freighter mobile does this in
 * src/helpers/stellar.ts (encodeSep53Message + Keypair.sign).
 */
export function sep53Digest(message: string): Buffer {
  return hash(
    Buffer.concat([
      Buffer.from("Stellar Signed Message:\n", "utf8"),
      Buffer.from(message, "utf8"),
    ])
  );
}

/**
 * Returns the base64 signature, the same shape the extension's v4 signMessage
 * returns, so signatureToHex() in register.ts handles both unchanged.
 *
 * The signature is verified against the signing address before we return it.
 * This is not paranoia: the first 32 bytes of this signature ARE the user's
 * Bullet identity seed (register.ts deriveBulletPubKey, notes.ts
 * deriveBulletKeys). If the mobile wallet ever signed a different preimage
 * than the extension, we would silently derive a different keypair and the
 * user would register a Bullet key their desktop can't reproduce, losing
 * access to their own notes. Refusing a signature we can't verify turns that
 * into a visible error.
 */
export async function wcSignMessage(message: string, address: string): Promise<string> {
  const res = await request<{ signature: string }>("stellar_signMessage", { message });
  if (!res?.signature) throw new Error("Freighter returned no signature.");

  const sig = Buffer.from(res.signature, "base64");
  if (!Keypair.fromPublicKey(address).verify(sep53Digest(message), sig)) {
    throw new Error(
      "Freighter's signature didn't match the expected SEP-53 format, so your Bullet key can't be derived safely. Use a desktop browser with the Freighter extension."
    );
  }
  return res.signature;
}
