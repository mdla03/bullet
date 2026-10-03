"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FreighterGate,
  useFreighterGate,
} from "@/components/FreighterGate";
import { deriveStealthDigest } from "@/lib/stealth";
import { leafIndexFromPathIndices, noteCommitment } from "@/lib/pool_note";
import { depositExistingNote, newNote, withdrawNote } from "@/lib/pool_ops";
import { fetchPath } from "@/lib/pool_path";
import {
  addNote,
  balanceByToken,
  listNotes,
  updateNote,
  type StoredNote,
} from "@/lib/pool_wallet";

const PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const DECIMALS = 10_000_000n;
const TOKENS = [
  { id: 1, label: "XLM" },
  { id: 0, label: "USDC" },
  { id: 2, label: "USDT" },
];
const labelFor = (id: number) => TOKENS.find((t) => t.id === id)?.label ?? `token ${id}`;

/** Decimal string to stroops, or null if not a positive amount. */
function toStroops(input: string): bigint | null {
  const m = input.trim().match(/^(\d+)(?:\.(\d{1,7}))?$/);
  if (!m) return null;
  const places = DECIMALS.toString().length - 1;
  const v = BigInt(m[1]) * DECIMALS + BigInt((m[2] ?? "").padEnd(places, "0") || "0");
  return v > 0n ? v : null;
}

function fmt(v: bigint): string {
  const places = DECIMALS.toString().length - 1;
  const whole = v / DECIMALS;
  const frac = (v % DECIMALS).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export default function PoolWallet() {
  const gate = useFreighterGate();
  const [address, setAddress] = useState<string>("");
  const [pubKeyHex, setPubKeyHex] = useState<string>("");
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const [tokenId, setTokenId] = useState(1);
  const [amount, setAmount] = useState("");

  const refresh = useCallback((addr: string) => setNotes(listNotes(addr)), []);

  const signTx = useCallback(async (xdr: string) => {
    const { freighterSignTransaction } = await import("@/lib/freighter");
    return freighterSignTransaction(xdr, PASSPHRASE);
  }, []);

  async function unlock() {
    setError("");
    try {
      const { freighterRequestAccess, freighterSignMessage } = await import("@/lib/freighter");
      const { signatureToHex, KEY_DOMAIN_MESSAGE } = await import("@/lib/register");
      const { deriveBulletKeys } = await import("@/lib/notes");
      const { address: addr } = await freighterRequestAccess();
      const signed = await freighterSignMessage(KEY_DOMAIN_MESSAGE, addr);
      const keys = deriveBulletKeys(signatureToHex(signed));
      setAddress(addr);
      setPubKeyHex(keys.pubKeyHex);
      refresh(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function doFund() {
    const stroops = toStroops(amount);
    if (!stroops) return void setError("Enter an amount.");
    setError("");
    setBusy("Shielding");
    try {
      // A fresh stealth digest marks the note as yours without putting your
      // bullet key on-chain. You hold the secret; this value is stored with it.
      const ownerDigest = deriveStealthDigest(pubKeyHex).recipientDigest;
      const note = newNote(ownerDigest, stroops, tokenId);
      // Persist the secret BEFORE the on-chain deposit: a crash in between must
      // not strand the funds. It just shows as pending until the deposit lands.
      addNote(address, { note, status: "pending", createdAt: new Date().toISOString() });
      refresh(address);
      const txHash = await depositExistingNote(address, note, signTx, setBusy);
      updateNote(address, note.secret, { fundedTx: txHash });
      refresh(address);
      setAmount("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  /** Flip any pending note the indexer has now placed to ready, recording its
   *  leaf index. A note stays pending only until its leaf is in the tree. */
  async function syncPending() {
    setBusy("Checking");
    try {
      for (const s of listNotes(address)) {
        if (s.status !== "pending") continue;
        const path = await fetchPath(noteCommitment(s.note));
        if (path) {
          updateNote(address, s.note.secret, {
            status: "ready",
            leafIndex: leafIndexFromPathIndices(path.pathIndices),
          });
        }
      }
      refresh(address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function doWithdraw(s: StoredNote) {
    setError("");
    setBusy("Withdrawing");
    try {
      const txHash = await withdrawNote(address, s.note, address, signTx, setBusy);
      updateNote(address, s.note.secret, { status: "spent", spentTx: txHash });
      refresh(address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    if (gate.state !== "ready") return;
    // Re-read if we already unlocked this session.
    if (address) refresh(address);
  }, [gate.state, address, refresh]);

  if (!address) {
    return (
      <FreighterGate
        state={gate.state}
        heading="Open your shielded balance"
        label={gate.state === "needs-connect" ? "Connect and open" : "Open with Freighter"}
        busyLabel="Waiting for Freighter…"
        onClick={unlock}
        busy={false}
      />
    );
  }

  const balances = balanceByToken(address);
  const live = notes.filter((n) => n.status !== "spent");

  return (
    <div className="space-y-4">
      <section className="space-y-2 rounded-2xl border border-fog bg-white p-5">
        <h2 className="text-sm font-medium">Shielded balance</h2>
        {Object.keys(balances).length === 0 ? (
          <p className="text-sm text-graphite">Nothing shielded yet.</p>
        ) : (
          <ul className="space-y-1 font-mono text-lg font-bold tracking-tight">
            {Object.entries(balances).map(([id, v]) => (
              <li key={id}>
                {fmt(v)} <span className="text-sm font-sans font-normal text-graphite">{labelFor(Number(id))}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-graphite">
          Held as notes in this browser, not on any server. An amount you shield
          and later send inside the pool never appears on-chain.
        </p>
      </section>

      <section className="space-y-3 rounded-2xl border border-fog bg-white p-5">
        <h2 className="text-sm font-medium">Shield funds</h2>
        <div className="flex gap-2">
          <select
            value={tokenId}
            onChange={(e) => setTokenId(Number(e.target.value))}
            className="rounded-xl border border-fog bg-paper px-3 py-2 text-sm"
          >
            {TOKENS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="w-full rounded-xl border border-fog bg-paper px-3 py-2 font-mono"
          />
        </div>
        <button
          onClick={doFund}
          disabled={!!busy}
          className="w-full rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
        >
          {busy || "Shield"}
        </button>
      </section>

      <section className="space-y-3 rounded-2xl border border-fog bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Notes</h2>
          <button
            onClick={syncPending}
            disabled={!!busy}
            className="rounded-full border border-fog px-3 py-1 text-xs text-graphite hover:border-ink disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
        {live.length === 0 ? (
          <p className="text-sm text-graphite">No notes.</p>
        ) : (
          <ul className="space-y-2">
            {live.map((s) => (
              <li
                key={s.note.secret}
                className="flex items-center justify-between rounded-xl border border-fog px-3 py-2"
              >
                <div>
                  <p className="font-mono text-sm font-bold tracking-tight">
                    {fmt(s.note.value)} {labelFor(s.note.tokenId)}
                  </p>
                  <p className="text-xs text-graphite">
                    {s.status === "pending" ? "Settling. Refresh in a moment." : "Ready"}
                  </p>
                </div>
                <button
                  onClick={() => doWithdraw(s)}
                  disabled={!!busy}
                  className="rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-paper hover:bg-ink/85 disabled:opacity-50"
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-graphite">
          Withdraw sends a note back to your connected wallet. The amount is
          visible on that step, by design. What stays hidden is the transfer
          inside the pool.
        </p>
      </section>

      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
