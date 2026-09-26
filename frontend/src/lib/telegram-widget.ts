// Telegram handle linking, driven from our own button.
//
// Telegram's loader (telegram.org/js/telegram-widget.js) cannot run under this
// app's CSP at all: it parses its data-onauth attribute with eval(), and the
// EvalError aborts it before it inserts anything. Embedding its frame directly
// works, but the frame renders Telegram's own blue button, cross-origin, and
// no style of ours can reach inside it.
//
// So we drive the same flow the frame drives, from a Bullet-styled button:
//
//   1. open oauth.telegram.org/auth in a popup. That window is top-level, so
//      the user's Telegram session cookie there is first-party and the login
//      works exactly as it does for the official widget.
//   2. once the popup closes, POST oauth.telegram.org/auth/get with
//      credentials. An authorized session answers with the signed `user`
//      payload; anything else means the user did not finish.
//   3. hand that payload to our backend, which re-verifies Telegram's
//      signature and its auth_date window before writing the handle.
//
// Step 2 is how the official widget reads its result too (widget-frame.js,
// TWidgetLogin.getAuth, called from onClose), not something we invented. It is
// not a documented API though, so Telegram can change it under us. If they do,
// linking fails loudly and nothing else is affected.

export const AUTH_ORIGIN = "https://oauth.telegram.org";

/** Popup geometry, matching the widget's own (widget-frame.js TWidgetLogin). */
const POPUP = { width: 550, height: 470 };

/** How often to check whether the user is done with the popup. */
const POLL_MS = 100;

/** What Telegram hands back. Passed to our backend untouched: Telegram's hash
 *  covers exactly these fields, so re-shaping them would break the signature
 *  check that is the whole proof of ownership. */
export type TelegramUser = Record<string, string | number>;

/** URL of the login popup for a bot. */
export function authUrl(botId: string, origin: string): string {
  return `${AUTH_ORIGIN}/auth?${new URLSearchParams({ bot_id: botId, origin })}`;
}

/**
 * Asks Telegram whether the session that just used the popup is authorized for
 * this bot, and returns the signed payload if it is.
 *
 * Null means not authorized, which is the ordinary case of someone closing the
 * popup without finishing. It throws only when the request itself failed,
 * which is the case worth surfacing: a browser blocking third-party cookies
 * lands here, and no login can succeed until that changes.
 */
export async function fetchAuthResult(botId: string, origin: string): Promise<TelegramUser | null> {
  const res = await fetch(`${AUTH_ORIGIN}/auth/get?bot_id=${encodeURIComponent(botId)}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: new URLSearchParams({ origin }).toString(),
  });
  if (!res.ok) throw new Error(`Telegram returned ${res.status}.`);
  const body = (await res.json()) as { user?: TelegramUser };
  // An unfinished login answers {"error": "NOT_AUTHORIZED"} with no user.
  return body.user ?? null;
}

/**
 * Opens the login popup, centred the way the official widget centres it.
 * Null means a popup blocker stopped it, so the caller can say so rather than
 * waiting on a window that does not exist.
 */
export function openAuthPopup(botId: string, origin: string): Window | null {
  const left = Math.max(0, (screen.width - POPUP.width) / 2);
  const top = Math.max(0, (screen.height - POPUP.height) / 2);
  return window.open(
    authUrl(botId, origin),
    "telegram_oauth",
    `width=${POPUP.width},height=${POPUP.height},left=${left},top=${top},status=0,location=0,menubar=0,toolbar=0`
  );
}

/** Resolves once the user has closed `popup`. */
export function whenClosed(popup: Window, pollMs: number = POLL_MS): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (popup.closed ? resolve() : setTimeout(tick, pollMs));
    tick();
  });
}

/** Thrown when the popup never opened, which is a blocker rather than a
 *  decision by the user and needs different wording. */
export class PopupBlocked extends Error {
  constructor() {
    super("Allow popups for this site to continue with Telegram.");
    this.name = "PopupBlocked";
  }
}

/**
 * The whole login: open the popup, wait for the user, read the result.
 *
 * Null means they closed it without finishing, which both callers treat as a
 * cancel. Throws PopupBlocked if the window never opened, and passes through
 * the lookup's own error if Telegram could not be reached.
 */
export async function loginWithTelegram(botId: string): Promise<TelegramUser | null> {
  const origin = window.location.origin;
  const popup = openAuthPopup(botId, origin);
  if (!popup) throw new PopupBlocked();
  await whenClosed(popup);
  return fetchAuthResult(botId, origin);
}
