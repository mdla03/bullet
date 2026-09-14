"use client";

import { useEffect, useRef, useState } from "react";
import { TelegramIcon } from "@/components/icons";
import { apiFetch } from "@/lib/api";

// The bot whose Login Widget is rendered. Unset in an environment that has no
// bot configured, and then this component renders nothing at all: the backend
// would 503 the link anyway (TELEGRAM_BOT_TOKEN), so a button that cannot work
// is worse than no button.
const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

// Telegram's widget calls a function it looks up by name on `window`, named in
// the script's data-onauth attribute. There is one widget on screen at a time,
// so one fixed name is enough.
const CALLBACK = "onBulletTelegramAuth";

/** What the widget hands back. Passed through to the backend untouched: the
 *  hash covers exactly these fields, so re-shaping them here would break the
 *  signature check. */
type TelegramUser = Record<string, string | number>;

declare global {
  interface Window {
    [CALLBACK]?: (user: TelegramUser) => void;
  }
}

/**
 * Telegram Login Widget plus the link call behind it.
 *
 * Telegram is not a Supabase OAuth provider, so this proves ownership through
 * our own backend instead of signInWithOAuth: the widget returns a payload
 * Telegram signed, POST /telegram/link verifies that signature with the bot
 * token and writes the handle for the signed-in user. `onLinked` then refreshes
 * the handle list, the same way returning from an OAuth callback does.
 */
export function TelegramLogin({ onLinked }: { onLinked: () => void | Promise<void> }) {
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const el = slot.current;
    if (!BOT_USERNAME || !el) return;

    window[CALLBACK] = async (user: TelegramUser) => {
      setError("");
      try {
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
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", BOT_USERNAME);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-onauth", `${CALLBACK}(user)`);
    el.appendChild(script);

    return () => {
      delete window[CALLBACK];
      el.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!BOT_USERNAME) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center gap-2 text-sm font-medium text-graphite">
        <TelegramIcon className="h-4 w-4" />
        Connect Telegram
      </div>
      {/* Telegram renders its own button in here. Its markup is fixed, so it
          sits centred rather than being restyled into a pill. */}
      <div ref={slot} className="flex justify-center" />
      {error && <p className="text-center text-sm text-graphite">{error}</p>}
    </div>
  );
}
