import {
  enabledHandleTypes,
  handleTypeForCanonical,
  handleTypeForIdentityProvider,
} from "@zeekpay/shared";

/** Every handle type in registry order, so a platform with nothing yet still
 *  shows as a zero rather than vanishing. A missing row and a zero row mean
 *  very different things when the question is "does this platform work".
 *  Email is left out: it canonicalizes a bare address exactly as Google does,
 *  so its row restated Google's and always read zero sends. Links proven by
 *  email OTP are folded into Google below rather than dropped. */
export const HANDLE_TYPES = enabledHandleTypes().filter((t) => t.id !== "email");

/** Counts per handle type, keyed by type id, starting at zero for all. */
export function emptyByType(): Map<string, number> {
  return new Map(HANDLE_TYPES.map((t) => [t.id, 0]));
}

/** Shape of public.dashboard_metrics()'s jsonb. Values are raw: stroops,
 *  provider strings, canonical handles. */
export interface RawMetrics {
  deposits: number;
  cursor_ledger: number | null;
  users: number;
  unclaimed_notes: number;
  pending_invites: number;
  transactions: number;
  sends: number;
  claims: number;
  active_accounts: number;
  volume: Record<string, number>;
  daily: { date: string; sends: number; claims: number }[];
  dau: number;
  mau: number;
  wallets_attached: number;
  wallets_unique: number;
  handles: Record<string, number>;
  sends_by_handle: Record<string, number>;
  recent: {
    type: "send" | "claim";
    amount: number;
    token_id: number | null;
    tx_hash: string | null;
    created_at: string;
  }[];
}

const STROOPS = 10_000_000;

/** Raw aggregates to what the page renders. Kept pure and out of the page so
 *  the registry folding below is testable without a database. */
export function mapMetrics(raw: RawMetrics) {
  // Linked handles per platform. Maps the raw auth.identities provider
  // ("twitter_v2", "github", …) through the registry rather than matching
  // strings here, so the three D3 platforms and X's three provider spellings
  // all land in the right bucket without a second list to keep in sync.
  const linkedHandles = emptyByType();
  for (const [provider, n] of Object.entries(raw.handles ?? {})) {
    const type = handleTypeForIdentityProvider(provider);
    if (!type) continue;
    // Email and Google are one address and one person, and the table shows one
    // row for them. Count an email-OTP link under Google rather than losing it.
    const id = type.id === "email" ? "google" : type.id;
    linkedHandles.set(id, (linkedHandles.get(id) ?? 0) + n);
  }

  // Sends per recipient handle type. activity.handle is the recipient's
  // canonical handle on sends and null on claims, so this counts what was
  // actually paid at each platform.
  //
  // Google and email share a canonical form (a bare address), and
  // handleTypeForCanonical returns the first type that claims it, which is
  // Google. Sends to an email address therefore count under Google. That is
  // the registry's own resolution order, the same one /resolve uses, so the
  // number matches the rest of the system rather than disagreeing with it.
  const sendsByType = emptyByType();
  let sendsUnknownType = 0;
  for (const [handle, n] of Object.entries(raw.sends_by_handle ?? {})) {
    const type = handleTypeForCanonical(handle);
    if (!type) {
      sendsUnknownType += n;
      continue;
    }
    const id = type.id === "email" ? "google" : type.id;
    sendsByType.set(id, (sendsByType.get(id) ?? 0) + n);
  }

  return {
    deposits: raw.deposits,
    cursorLedger: raw.cursor_ledger,
    transactions: raw.transactions,
    sends: raw.sends,
    claims: raw.claims,
    activeAccounts: raw.active_accounts,
    // Already lowest token id first: the keys are integer-like, and JS iterates
    // those in ascending numeric order whatever the json listed them in. A
    // sort here looked load-bearing and could never fire.
    volume: Object.entries(raw.volume ?? {}).map(
      ([id, total]) => [Number(id), total / STROOPS] as [number, number]
    ),
    users: raw.users,
    walletsConnected: raw.wallets_unique,
    walletsAttached: raw.wallets_attached,
    dau: raw.dau,
    mau: raw.mau,
    unclaimedNotes: raw.unclaimed_notes,
    pendingInvites: raw.pending_invites,
    daily: raw.daily ?? [],
    linkedHandles,
    sendsByType,
    sendsUnknownType,
    recent: raw.recent ?? [],
  };
}
