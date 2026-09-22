// Turns a raw send/claim tx or RPC error (often a multi-KB Soroban HostError
// dump of diagnostic events) into a short, factual line for display. The raw
// text is never discarded, callers keep it as ErrorDetails' `details` prop.
export function humanizeChainError(
  raw: string,
  assetLabel?: string,
  context: "claim" | "send" = "claim"
): string {
  if (/trustline entry is missing/i.test(raw)) {
    return assetLabel
      ? `Your wallet has no ${assetLabel} trustline yet.`
      : "Your wallet is missing a trustline for this asset.";
  }
  if (/Account not found/i.test(raw))
    return "Your Stellar wallet isn't funded on testnet yet. Grab free XLM from friendbot.stellar.org and try again.";
  // placeholder for a code table keyed to the contract's Error enum in
  // contracts/zeekpay/src/lib.rs, follow-up.
  if (/NullifierUsed|Error\(Contract, #6\)/i.test(raw))
    return "This note has already been claimed.";
  if (context === "send") {
    // Long strings here are Soroban HostError diagnostic dumps, not
    // something worth showing inline. Short messages are usually already
    // human-readable (a thrown Error's own text), so they're shown as-is
    // instead of being collapsed into a generic line.
    if (raw.length > 160) return "Send failed. The network rejected the transaction.";
    return raw;
  }
  return "Claim failed. The network rejected the transaction.";
}
