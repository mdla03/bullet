// Thin wrapper around @stellar/freighter-api that adds a timeout.
// Freighter mobile's built-in browser sometimes hangs on requestAccess()
// without ever resolving. This prevents the UI from getting stuck.

const TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out. Make sure Freighter is unlocked and try again.`)), ms)
    ),
  ]);
}

export async function freighterRequestAccess(): Promise<{ address: string }> {
  const { requestAccess } = await import("@stellar/freighter-api");
  const res = await withTimeout(requestAccess(), TIMEOUT_MS, "Freighter connect");
  if ("error" in res && res.error) throw new Error(`Freighter: ${res.error}`);
  return { address: res.address };
}

export async function freighterSignTransaction(
  xdr: string,
  networkPassphrase: string
): Promise<string> {
  const { signTransaction } = await import("@stellar/freighter-api");
  const res = await withTimeout(
    signTransaction(xdr, { networkPassphrase }),
    TIMEOUT_MS,
    "Freighter signing"
  );
  if ("error" in res) throw new Error(`Freighter: ${res.error}`);
  return res.signedTxXdr;
}

export async function freighterSignMessage(
  message: string,
  address: string
): Promise<string | Buffer> {
  const { signMessage } = await import("@stellar/freighter-api");
  const res = await withTimeout(
    signMessage(message, { address }),
    TIMEOUT_MS,
    "Freighter signing"
  );
  if (res.error || !res.signedMessage)
    throw new Error(`Freighter: ${res.error?.message ?? "signature rejected"}`);
  return res.signedMessage as string | Buffer;
}
