// A local wallet of the owner's shielded-pool notes, in localStorage, keyed by
// connected Stellar address.
//
// A pool note is a spendable balance: whoever holds its secret can spend it.
// Self-held notes (shielded by you, change from your sends) live here, on your
// device, rather than as ciphertext on a server, so your own balance is not
// observable anywhere off-chain. The trade-off is that clearing the browser or
// switching devices loses them; delivering a note to someone ELSE goes through
// the encrypted inbox instead (see the transfer flow).
//
// bigint does not survive JSON, so `value` is stored as a decimal string and
// rehydrated. serializeNote/deserializeNote are pure and tested.

import type { PoolNote } from "./pool_note";

export type NoteStatus = "pending" | "ready" | "spent";

export interface StoredNote {
  note: PoolNote;
  status: NoteStatus;
  /** The deposit tx that created it (fund) or the transact that produced it. */
  fundedTx?: string;
  /** The transact that spent it (withdraw/transfer). */
  spentTx?: string;
  createdAt: string;
}

interface StoredNoteJson {
  secret: string;
  recipientDigest: string;
  value: string;
  tokenId: number;
  leafIndex?: number;
  status: NoteStatus;
  fundedTx?: string;
  spentTx?: string;
  createdAt: string;
}

const KEY_PREFIX = "bullet.pool.notes.";
const keyFor = (address: string) => KEY_PREFIX + address;

export function serializeNote(s: StoredNote): StoredNoteJson {
  return {
    secret: s.note.secret,
    recipientDigest: s.note.recipientDigest,
    value: s.note.value.toString(),
    tokenId: s.note.tokenId,
    leafIndex: s.note.leafIndex,
    status: s.status,
    fundedTx: s.fundedTx,
    spentTx: s.spentTx,
    createdAt: s.createdAt,
  };
}

export function deserializeNote(j: StoredNoteJson): StoredNote {
  return {
    note: {
      secret: j.secret,
      recipientDigest: j.recipientDigest,
      value: BigInt(j.value),
      tokenId: j.tokenId,
      leafIndex: j.leafIndex,
    },
    status: j.status,
    fundedTx: j.fundedTx,
    spentTx: j.spentTx,
    createdAt: j.createdAt,
  };
}

function read(address: string): StoredNote[] {
  try {
    const raw = localStorage.getItem(keyFor(address));
    if (!raw) return [];
    return (JSON.parse(raw) as StoredNoteJson[]).map(deserializeNote);
  } catch {
    return [];
  }
}

function write(address: string, notes: StoredNote[]): void {
  localStorage.setItem(keyFor(address), JSON.stringify(notes.map(serializeNote)));
}

export function listNotes(address: string): StoredNote[] {
  return read(address);
}

/** Spendable balance per token id, summing notes not yet spent. */
export function balanceByToken(address: string): Record<number, bigint> {
  const out: Record<number, bigint> = {};
  for (const s of read(address)) {
    if (s.status === "spent") continue;
    out[s.note.tokenId] = (out[s.note.tokenId] ?? 0n) + s.note.value;
  }
  return out;
}

export function addNote(address: string, entry: StoredNote): void {
  write(address, [...read(address), entry]);
}

/** Patch the stored note whose secret matches, e.g. to mark it spent. Secret is
 *  the stable identity: the commitment can be recomputed from it, and two notes
 *  never share one. */
export function updateNote(
  address: string,
  secret: string,
  patch: Partial<Omit<StoredNote, "note">> & { leafIndex?: number }
): void {
  const notes = read(address).map((s) => {
    if (s.note.secret !== secret) return s;
    const { leafIndex, ...rest } = patch;
    return {
      ...s,
      ...rest,
      note: leafIndex === undefined ? s.note : { ...s.note, leafIndex },
    };
  });
  write(address, notes);
}
