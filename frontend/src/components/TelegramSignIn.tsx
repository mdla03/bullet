"use client";

import { useState } from "react";
import { LoaderIcon, TelegramIcon } from "@/components/icons";
import { telegramSignIn } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { loginWithTelegram } from "@/lib/telegram-widget";

// The bot this signs in through. Unset in an environment with no bot
// configured, and the button does not render: the backend would 503 the call
// anyway (TELEGRAM_BOT_TOKEN), and a dead sign-in option is worse than one
// fewer. The id is the numeric prefix of the bot token, which is public.
const BOT_ID = process.env.NEXT_PUBLIC_TELEGRAM_BOT_ID;

/**
 * "Continue with Telegram" on the sign-in step.
 *
 * The other providers hand off to Supabase, which creates the session, the
 * user and the identity row by itself. Telegram is not a Supabase provider, so
 * the session comes from our own backend instead: POST /telegram/signin
 * re-verifies Telegram's signature, finds or creates the user, and returns a
 * one-time token_hash. Exchanging it here is what actually signs the browser
 * in, and RegisterFlow's onAuthStateChange takes it from there.
 */
/**
 * `busy` and `onBusy` are the caller's own sign-in flag rather than state held
 * here: the other four buttons all read one shared `working` value, so they
 * spin together whichever of them was pressed. Owning a private flag here
 * would leave Telegram the odd one out in both directions, still showing its
 * icon while the others spun and vice versa.
 */
export function TelegramSignIn({
  busy,
  onBusy,
}: {
  busy?: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const [error, setError] = useState("");

  async function signIn() {
    if (!BOT_ID) return;
    setError("");
    onBusy?.(true);
    try {
      const user = await loginWithTelegram(BOT_ID);
      // Closing the popup without finishing is a cancel, not a failure.
      if (!user) return;

      const { token_hash } = await telegramSignIn(user);
      const supabase = createClient();
      const { error: otpErr } = await supabase.auth.verifyOtp({
        token_hash,
        type: "magiclink",
      });
      if (otpErr) setError(otpErr.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy?.(false);
    }
  }

  if (!BOT_ID) return null;

  return (
    <>
      <button
        onClick={signIn}
        disabled={busy}
        className="flex w-full items-center justify-center gap-3 rounded-full border border-fog bg-white px-5 py-3 font-medium transition-colors hover:border-graphite disabled:opacity-50"
      >
        {busy ? (
          <LoaderIcon className="h-5 w-5 animate-spin" />
        ) : (
          <TelegramIcon className="h-5 w-5" />
        )}
        <span>Continue with Telegram</span>
      </button>
      {error && <p className="text-center text-sm text-graphite">{error}</p>}
    </>
  );
}
