const TTL_MS = 5 * 60 * 1000;

export interface PendingEntry {
  handle: string;
  stellarAddress: string;
  zeekPayPubKey: string;
  signature: string;
  codeVerifier: string;
  expiresAt: number;
}

const map = new Map<string, PendingEntry>();

export function set(state: string, entry: Omit<PendingEntry, "expiresAt">): void {
  const now = Date.now();
  for (const [k, v] of map) {
    if (v.expiresAt <= now) map.delete(k);
  }
  map.set(state, { ...entry, expiresAt: now + TTL_MS });
}

export function get(state: string): Omit<PendingEntry, "expiresAt"> | undefined {
  const entry = map.get(state);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    map.delete(state);
    return undefined;
  }
  const { expiresAt: _, ...rest } = entry;
  return rest;
}

export function del(state: string): void {
  map.delete(state);
}
