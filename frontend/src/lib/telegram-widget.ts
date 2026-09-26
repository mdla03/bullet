// The Telegram Login Widget frame, without Telegram's loader script.
//
// telegram.org/js/telegram-widget.js cannot run under this app's CSP: it parses
// its data-onauth attribute with eval() (__parseFunction), and the EvalError
// aborts it before it inserts the iframe. Allowing 'unsafe-eval' for it would
// re-enable eval for the whole app, and its data-auth-url alternative puts the
// signed login payload in a query string. Everything the loader does for a
// login widget that we actually need is here instead: build the frame src, and
// decide what an incoming postMessage means.

/** Origin of the widget frame. Messages from anywhere else are not ours. */
export const WIDGET_ORIGIN = "https://oauth.telegram.org";

/** Default size of a `size=large` widget, from the loader's own defWidth /
 *  defHeight. Only used until the frame reports its real size. */
export const DEFAULT_SIZE = { width: 238, height: 40 };

/** What the widget hands back. Passed to the backend untouched: Telegram's
 *  hash covers exactly these fields, so re-shaping them breaks the signature
 *  check that proves ownership. */
export type TelegramUser = Record<string, string | number>;

export type WidgetMessage =
  | { type: "resize"; width?: number; height?: number }
  | { type: "auth"; user: TelegramUser }
  | null;

/** Frame URL for a bot's login widget, matching the src the loader builds. */
export function widgetSrc(bot: string, origin: string, returnTo: string): string {
  const params = new URLSearchParams({
    origin,
    return_to: returnTo,
    size: "large",
    userpic: "false",
  });
  return `${WIDGET_ORIGIN}/embed/${encodeURIComponent(bot)}?${params}`;
}

/**
 * Interprets one postMessage from the widget frame, or returns null for
 * anything this component should ignore.
 *
 * `trusted` is the caller's own check that the event came from this widget's
 * frame (origin *and* source). It is a parameter rather than something checked
 * here because the source check needs the live contentWindow; passing `true`
 * for an untrusted event is the one mistake this module cannot catch, so the
 * caller does both halves together.
 */
export function parseWidgetMessage(trusted: boolean, raw: unknown): WidgetMessage {
  if (!trusted || typeof raw !== "string") return null;
  let data: { event?: unknown; width?: unknown; height?: unknown; auth_data?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.event === "resize") {
    return {
      type: "resize",
      width: typeof data.width === "number" ? data.width : undefined,
      height: typeof data.height === "number" ? data.height : undefined,
    };
  }
  // `init: true` marks a user the frame recognised at load rather than one who
  // just pressed the button. The loader passed both to the same data-onauth
  // callback, and so do we: either way it is a freshly signed payload and the
  // backend re-verifies the signature and the auth_date window.
  if (data.event === "auth_user" && data.auth_data && typeof data.auth_data === "object") {
    return { type: "auth", user: data.auth_data as TelegramUser };
  }
  return null;
}
