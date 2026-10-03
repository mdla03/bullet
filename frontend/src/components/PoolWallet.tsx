"use client";

import { useCallback, useEffect, useState } from "react";
import { FreighterGate, useFreighterGate } from "@/components/FreighterGate";
import { deriveStealthDigest } from "@/lib/stealth";
import { leafIndexFromPathIndices, noteCommitment } from "@/lib/pool_note";
import { depositExistingNote, newNote, transferNote, withdrawNote } from "@/lib/pool_ops";
import { fetchPath } from "@/lib/pool_path";
import { fetchNotes, postNote, type BulletKeys } from "@/lib/notes";
import type { ClaimPayload } from "@/lib/claim_link";
import {
  addNote,
  balanceByToken,
  listNotes,
  updateNote,
  type StoredNote,
} from "@/lib/pool_wallet";

const PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const RESOLVER_URL = process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";
const DECIMALS = 10_000_000n;
const TOKENS = [
  { id: 1, label: "XLM" },
  { id: 0, label: "USDC" },
  { id: 2, label: "USDT" },
];
const labelFor = (id: number) => TOKENS.find((t) => t.id === id)?.label ?? `token ${id}`;

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
  const [address, setAddress] = useState("");
  const [keys, setKeys] = useState<BulletKeys | null>(null);
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note_, setNote] = useState("");

  const [tokenId, setTokenId] = useState(1);
  const [amount, setAmount] = useState("");

  const [handle, setHandle] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sourceSecret, setSourceSecret] = useState("");

  const refresh = useCallback((addr: string) => setNotes(listNotes(addr)), []);

  const signTx = useCallback(async (xdr: string) => {
    const { freighterSignTransaction } = await import("@/lib/freighter");
    return freighterSignTransaction(xdr, PASSPHRASE);
  }, []);

  /** Import pool notes delivered to this wallet's bullet key into the local
   *  wallet. Idempotent: a note already held (by secret) is skipped, so this is
   *  safe to run on every unlock. */
  const importDelivered = useCallback(async (k: BulletKeys, addr: string) => {
    const held = new Set(listNotes(addr).map((s) => s.note.secret));
    const incoming = (await fetchNotes(k)).filter((n) => n.payload.kind === "pool");
    let added = 0;
    for (const n of incoming) {
      const p = n.payload;
      if (held.has(p.secret)) continue;
      addNote(addr, {
        note: {
          secret: p.secret,
          recipientDigest: p.recipientDigest,
          value: BigInt(p.amount),
          tokenId: p.tokenId ?? 0,
          leafIndex: p.leafIndex,
        },
        status: "pending",
        createdAt: new Date().toISOString(),
      });
      added++;
    }
    if (added) refresh(addr);
    return added;
  }, [refresh]);

  async function unlock() {
    setError("");
    try {
      const { freighterRequestAccess, freighterSignMessage } = await import("@/lib/freighter");
      const { signatureToHex, KEY_DOMAIN_MESSAGE } = await import("@/lib/register");
      const { deriveBulletKeys } = await import("@/lib/notes");
      const { address: addr } = await freighterRequestAccess();
      const signed = await freighterSignMessage(KEY_DOMAIN_MESSAGE, addr);
      const k = deriveBulletKeys(signatureToHex(signed));
      setAddress(addr);
      setKeys(k);
      refresh(addr);
      importDelivered(k, addr).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function doFund() {
    if (!keys) return;
    const stroops = toStroops(amount);
    if (!stroops) return void setError("Enter an amount.");
    setError("");
    setBusy("Shielding");
    try {
      const ownerDigest = deriveStealthDigest(keys.pubKeyHex).recipientDigest;
      const n = newNote(ownerDigest, stroops, tokenId);
      // Persist the secret BEFORE the on-chain deposit: a crash in between must
      // not strand the funds. It shows as pending until the deposit lands.
      addNote(address, { note: n, status: "pending", createdAt: new Date().toISOString() });
      refresh(address);
      const txHash = await depositExistingNote(address, n, signTx, setBusy);
      updateNote(address, n.secret, { fundedTx: txHash });
      refresh(address);
      setAmount("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  /** Flip any pending note the indexer has now placed to ready, recording its
   *  leaf index. */
  async function syncPending() {
    setBusy("Checking");
    setNote("");
    try {
      if (keys) await importDelivered(keys, address);
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

  async function doSend() {
    if (!keys) return;
    const value = toStroops(sendAmount);
    const source = notes.find((n) => n.note.secret === sourceSecret);
    if (!source) return void setError("Pick a note to send from.");
    if (!value) return void setError("Enter an amount to send.");
    if (value > source.note.value) return void setError("Amount exceeds the note.");
    setError("");
    setNote("");
    setBusy("Resolving");
    try {
      const res = await fetch(`${RESOLVER_URL}/resolve?q=${encodeURIComponent(handle.trim())}`);
      const body = (await res.json()) as { found?: boolean; zeekPayPubKey?: string };
      if (!res.ok || !body.found || !body.zeekPayPubKey) {
        throw new Error("That handle is not registered with a wallet.");
      }
      const recipientPub = body.zeekPayPubKey;
      const recipientDigest = deriveStealthDigest(recipientPub).recipientDigest;
      const ownerDigest = deriveStealthDigest(keys.pubKeyHex).recipientDigest;

      const { txHash, recipientNote, changeNote } = await transferNote(
        address,
        source.note,
        recipientDigest,
        value,
        ownerDigest,
        signTx,
        setBusy
      );

      // Consume the source, keep the change. Do this before delivery so a
      // delivery failure cannot double-count the spent note locally.
      updateNote(address, source.note.secret, { status: "spent", spentTx: txHash });
      if (changeNote) {
        addNote(address, {
          note: changeNote,
          status: "pending",
          fundedTx: txHash,
          createdAt: new Date().toISOString(),
        });
      }
      refresh(address);

      // Deliver the recipient's note over the encrypted inbox.
      setBusy("Delivering");
      const payload: ClaimPayload = {
        kind: "pool",
        secret: recipientNote.secret,
        recipientDigest: recipientNote.recipientDigest,
        amount: Number(recipientNote.value),
        tokenId: recipientNote.tokenId,
        recipientHandle: handle.trim(),
      };
      await postNote(payload, recipientPub);

      setNote(`Sent. ${handle.trim()} can withdraw it from their pool.`);
      setHandle("");
      setSendAmount("");
      setSourceSecret("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    if (gate.state === "ready" && address) refresh(address);
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
  const ready = live.filter((n) => n.status === "ready");

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
                {fmt(v)}{" "}
                <span className="text-sm font-sans font-normal text-graphite">{labelFor(Number(id))}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-graphite">
          Held as notes in this browser, not on any server. An amount you shield
          and send inside the pool never appears on-chain.
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
        <h2 className="text-sm font-medium">Send privately</h2>
        <p className="text-xs text-graphite">
          Pay a handle from a shielded note. The amount is hidden on-chain.
          Only ready notes can be sent.
        </p>
        <select
          value={sourceSecret}
          onChange={(e) => setSourceSecret(e.target.value)}
          className="w-full rounded-xl border border-fog bg-paper px-3 py-2 text-sm"
        >
          <option value="">From note…</option>
          {ready.map((s) => (
            <option key={s.note.secret} value={s.note.secret}>
              {fmt(s.note.value)} {labelFor(s.note.tokenId)}
            </option>
          ))}
        </select>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="@handle, github:name, email"
          className="w-full rounded-xl border border-fog bg-paper px-3 py-2"
        />
        <input
          value={sendAmount}
          onChange={(e) => setSendAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          className="w-full rounded-xl border border-fog bg-paper px-3 py-2 font-mono"
        />
        <button
          onClick={doSend}
          disabled={!!busy || ready.length === 0}
          className="w-full rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
        >
          {busy || "Send privately"}
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
                  disabled={!!busy || s.status !== "ready"}
                  className="rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-paper hover:bg-ink/85 disabled:opacity-50"
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-graphite">
          Withdraw sends a note to your connected wallet. The amount is visible on
          that step, by design. The transfer inside the pool is what stays hidden.
        </p>
      </section>

      {note_ && (
        <p className="rounded-xl border border-fog bg-white px-4 py-3 text-sm text-graphite">
          {note_}
        </p>
      )}
      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
