"use client";

import { useState } from "react";
import { LoaderIcon, TelegramIcon } from "@/components/icons";
import { apiFetch } from "@/lib/api";
import { loginWithTelegram } from "@/lib/telegram-widget";

// The bot this links against. Unset in an environment with no bot configured,
// and then this component renders nothing at all: the backend would 503 the
// link anyway (TELEGRAM_BOT_TOKEN), so a button that cannot work is worse than
// no button. The id is the numeric prefix of the bot token, which is public.
const BOT_ID = process.env.NEXT_PUBLIC_TELEGRAM_BOT_ID;

/**
 * Connect Telegram, styled as one of this screen's connect buttons.
 *
 * Telegram is not a Supabase OAuth provider, so ownership is proved through our
 * own backend rather than signInWithOAuth: the login popup produces a payload
 * Telegram signed, POST /telegram/link verifies that signature with the bot
 * token and writes the handle. `onLinked` then refreshes the handle list, the
 * same way returning from an OAuth callback does. See lib/telegram-widget.ts
 * for why this drives the flow itself instead of embedding Telegram's widget.
 */
export function TelegramLogin({ onLinked }: { onLinked: () => void | Promise<void> }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    if (!BOT_ID) return;
    setError("");
    setWorking(true);
    try {
      const user = await loginWithTelegram(BOT_ID);
      // No payload means the popup was closed without finishing. That is a
      // cancel, not a failure, so it passes without an error message.
      if (!user) return;

      const res = await apiFetch("/telegram/link", {
        method: "POST",
        body: JSON.stringify(user),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        setError(body.detail ?? `Could not link this Telegram account (${res.status}).`);
        return;
      }
      await onLinked();
    } catch (e) {
      // Reaching here means the lookup itself failed rather than the user
      // declining: most likely a browser refusing Telegram's cookie on a
      // cross-site request, which no retry will fix.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  if (!BOT_ID) return null;

  return (
    <div className="space-y-2">
      <button
        onClick={connect}
        disabled={working}
        className="flex w-full items-center justify-center gap-2 rounded-full border border-fog bg-white px-4 py-2.5 text-sm font-medium transition-colors hover:border-graphite disabled:opacity-50"
      >
        {working ? (
          <LoaderIcon className="h-4 w-4 animate-spin" />
        ) : (
          <TelegramIcon className="h-4 w-4" />
        )}
        Connect Telegram
      </button>
      {error && <p className="text-center text-sm text-graphite">{error}</p>}
    </div>
  );
}
