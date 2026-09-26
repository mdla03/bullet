"use client";

import { useEffect, useRef, useState } from "react";
import { TelegramIcon } from "@/components/icons";
import { apiFetch } from "@/lib/api";
import {
  DEFAULT_SIZE,
  WIDGET_ORIGIN,
  parseWidgetMessage,
  widgetSrc,
  type TelegramUser,
} from "@/lib/telegram-widget";

// The bot whose Login Widget is rendered. Unset in an environment that has no
// bot configured, and then this component renders nothing at all: the backend
// would 503 the link anyway (TELEGRAM_BOT_TOKEN), so a button that cannot work
// is worse than no button.
const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

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
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  // The frame reports its own size once it has rendered the button. Seeded with
  // the loader's own defaults for a large widget so it is not zero before then.
  const [size, setSize] = useState(DEFAULT_SIZE);
  // window.location is read in the effect, not during render: the src has to be
  // identical between server and client markup or React discards the frame.
  const [src, setSrc] = useState("");

  useEffect(() => {
    if (!BOT_USERNAME) return;
    setSrc(widgetSrc(BOT_USERNAME, window.location.origin, window.location.href));

    const link = async (user: TelegramUser) => {
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

    const onMessage = (e: MessageEvent) => {
      // Pinned to both the origin and this exact frame: any other window may
      // post to us, and the payload below is what proves handle ownership.
      const trusted = e.origin === WIDGET_ORIGIN && e.source === frame.current?.contentWindow;
      const msg = parseWidgetMessage(trusted, e.data);
      if (msg?.type === "resize") {
        setSize((s) => ({ width: msg.width ?? s.width, height: msg.height ?? s.height }));
      } else if (msg?.type === "auth") {
        void link(msg.user);
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
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
      <div className="flex justify-center">
        {src && (
          <iframe
            ref={frame}
            src={src}
            title="Log in with Telegram"
            style={{ width: size.width, height: size.height, border: 0, colorScheme: "light" }}
          />
        )}
      </div>
      {error && <p className="text-center text-sm text-graphite">{error}</p>}
    </div>
  );
}
