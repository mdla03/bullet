// Token identity shared across the app: which SAC contract backs each token
// id, and which id is the native XLM asset. Single source of truth so
// trustline.ts and invite_claim.ts don't carry their own copies of the same
// table (they used to, and drifted).
const USDC_SAC = process.env.NEXT_PUBLIC_USDC_SAC_ID ?? "";
const XLM_SAC = process.env.NEXT_PUBLIC_XLM_SAC_ID ?? "";
const USDT_SAC = process.env.NEXT_PUBLIC_USDT_SAC_ID ?? "";

export const TOKEN_SAC: Record<number, string> = { 0: USDC_SAC, 1: XLM_SAC, 2: USDT_SAC };

export const NATIVE_TOKEN_ID = 1;
