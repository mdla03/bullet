"use client";

import { useCallback, useEffect, useState } from "react";
import { freighterAccessState, freighterRequestAccess } from "@/lib/freighter";
import { ExternalLinkIcon, LoaderIcon, WalletIcon } from "@/components/icons";

export type FreighterGateState = "checking" | "ready" | "needs-connect" | "not-installed";

const PILL =
  "flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50";

/** Whether this site can use Freighter. Re-checks on focus and tab visibility,
 * so revoking access in Freighter or another tab shows up here. */
export function useFreighterGate() {
  const [state, setState] = useState<FreighterGateState>("checking");
  const [connecting, setConnecting] = useState(false);
  const recheck = useCallback(() => {
    freighterAccessState().then(setState);
  }, []);
  useEffect(() => {
    recheck();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [recheck]);
  /** Opens the connect popup, then re-checks. A rejected popup leaves the gate up. */
  const connect = useCallback(async () => {
    setConnecting(true);
    await freighterRequestAccess().catch(() => {});
    setConnecting(false);
    recheck();
  }, [recheck]);
  return { state, connect, connecting };
}

/** Raw Freighter error for a site that lost its grant mid-flow. */
export const isFreighterAccessLost = (raw: string) => /not currently connected/i.test(raw);

export function ConnectFreighterButton({
  onClick,
  busy = false,
  label = "Connect Freighter",
  busyLabel = "Connecting…",
}: {
  onClick: () => void;
  busy?: boolean;
  label?: string;
  busyLabel?: string;
}) {
  return (
    <button onClick={onClick} disabled={busy} className={PILL}>
      {busy ? <LoaderIcon className="h-5 w-5 animate-spin" /> : <WalletIcon className="h-5 w-5" />}
      {busy ? busyLabel : label}
    </button>
  );
}

export function InstallFreighterLink() {
  return (
    <a href="https://www.freighter.app" target="_blank" rel="noopener noreferrer" className={PILL}>
      <ExternalLinkIcon className="h-5 w-5" />
      Install Freighter
    </a>
  );
}

/** The card shown in place of a wallet page until Freighter is usable. */
export function FreighterGate({
  state,
  heading = "Connect wallet",
  ...button
}: { state: FreighterGateState; heading?: string } & Parameters<typeof ConnectFreighterButton>[0]) {
  const missing = state === "not-installed";
  return (
    <div className="space-y-4 rounded-2xl border border-fog bg-white p-6">
      <h2 className="text-xl font-bold tracking-tight">
        {missing ? "Freighter is not installed" : heading}
      </h2>
      {missing ? <InstallFreighterLink /> : <ConnectFreighterButton {...button} />}
    </div>
  );
}

/** Shown when signing fails because Freighter dropped this site mid-flow.
 * Asks for access again, then runs the action that failed. */
export function FreighterLostAccess({ onRetry }: { onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  async function reconnect() {
    setBusy(true);
    try {
      await freighterRequestAccess();
    } catch {
      return;
    } finally {
      setBusy(false);
    }
    onRetry();
  }
  return (
    <div className="space-y-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
      <p>Freighter lost access to this site.</p>
      <button
        onClick={reconnect}
        disabled={busy}
        className="flex items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
      >
        {busy ? <LoaderIcon className="h-4 w-4 animate-spin" /> : <WalletIcon className="h-4 w-4" />}
        {busy ? "Connecting…" : "Connect Freighter"}
      </button>
    </div>
  );
}
