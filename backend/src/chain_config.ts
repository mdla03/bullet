// Shared Soroban connection config. Single source for the env names +
// fallback order that invite.ts, indexer.ts and resolver.ts's /health each
// used to reimplement separately.

// BULLET_RPC_URL, not SOROBAN_RPC_URL: the stellar CLI auto-loads .env from the
// working directory and treats a SOROBAN_RPC_URL key there as an --rpc-url it
// has no passphrase for, which breaks its built-in `testnet` alias for every
// command run inside the repo. SOROBAN_RPC_URL is still read as a fallback so a
// deployment that has not been renamed yet keeps working.
export const RPC_URL =
  process.env.BULLET_RPC_URL ??
  process.env.SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";
export const CONTRACT_ID = process.env.ZEEKPAY_CONTRACT_ID ?? "";
export const ADMIN_KEY = process.env.ZEEKPAY_ADMIN_KEY ?? "";
