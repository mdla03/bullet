// One wallet interface for both Freighter builds. Every caller uses these
// functions and never picks a transport itself.
//
// @stellar/freighter-api only speaks to the browser extension: it posts a
// FREIGHTER_EXTERNAL_MSG_REQUEST on window and waits for the content script to
// answer. Freighter's mobile app has no content script, so nothing ever
// replies and every call hangs until the timeout below. All the mobile app
// injects is a marker object, so detect it and route to WalletConnect
// (lib/walletconnect.ts) instead.

const TIMEOUT_MS = 15_000;

declare global {
  interface Window {
    stellar?: { provider?: string; platform?: string };
  }
}

/** True inside the Freighter mobile app's in-app browser. */
export function isFreighterMobileBrowser(): boolean {
  return typeof window !== "undefined" && window.stellar?.platform === "mobile";
}

/** Freighter errors are sometimes a string, sometimes an { message } object. Normalize to text. */
function freighterErrorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `${label} timed out. Make sure the Freighter extension is installed and unlocked, then try again.`
            )
          ),
        ms
      )
    ),
  ]);
}

export async function freighterRequestAccess(): Promise<{ address: string }> {
  if (isFreighterMobileBrowser()) {
    const { wcConnect } = await import("@/lib/walletconnect");
    return { address: await wcConnect() };
  }
  const { requestAccess } = await import("@stellar/freighter-api");
  const res = await withTimeout(requestAccess(), TIMEOUT_MS, "Freighter connect");
  if ("error" in res && res.error) throw new Error(`Freighter: ${freighterErrorText(res.error)}`);
  return { address: res.address };
}

/** Returns the address ONLY if this site is already whitelisted in Freighter.
 * Does not trigger the connect popup. Returns null on any error. */
export async function freighterGetAddressIfAllowed(): Promise<string | null> {
  if (isFreighterMobileBrowser()) return null;
  try {
    const { getAddress } = await import("@stellar/freighter-api");
    const res = await withTimeout(getAddress(), 3_000, "Freighter address");
    if ("error" in res && res.error) return null;
    return res.address || null;
  } catch {
    return null;
  }
}

export async function freighterSignTransaction(
  xdr: string,
  networkPassphrase: string
): Promise<string> {
  if (isFreighterMobileBrowser()) {
    const { wcSignTransaction } = await import("@/lib/walletconnect");
    return wcSignTransaction(xdr, networkPassphrase);
  }
  const { signTransaction } = await import("@stellar/freighter-api");
  const res = await withTimeout(
    signTransaction(xdr, { networkPassphrase }),
    TIMEOUT_MS,
    "Freighter signing"
  );
  if ("error" in res) throw new Error(`Freighter: ${freighterErrorText(res.error)}`);
  return res.signedTxXdr;
}

export async function freighterSignMessage(
  message: string,
  address: string
): Promise<string | Buffer> {
  if (isFreighterMobileBrowser()) {
    const { wcSignMessage } = await import("@/lib/walletconnect");
    return wcSignMessage(message, address);
  }
  const { signMessage } = await import("@stellar/freighter-api");
  const res = await withTimeout(
    signMessage(message, { address }),
    TIMEOUT_MS,
    "Freighter signing"
  );
  if (res.error || !res.signedMessage)
    throw new Error(`Freighter: ${res.error ? freighterErrorText(res.error) : "signature rejected"}`);
  return res.signedMessage as string | Buffer;
}
