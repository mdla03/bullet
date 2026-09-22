"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getMe } from "@/lib/api";
import {
  ChevronDownIcon,
  InboxIcon,
  LogOutIcon,
  RefreshIcon,
  SendIcon,
} from "@/components/icons";

export default function IslandNav() {
  const [scrolled, setScrolled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const lastY = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 12);
      setHidden(y > 120 && y > lastY.current);
      lastY.current = y;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    // Belt-and-suspenders: if getSession() never settles (hydration hiccup,
    // dropped promise, slow network), stop treating the header as "loading"
    // after 1.5s so it can't stay blank forever. Cleared below the moment the
    // real session arrives, so the normal fast path never flashes.
    const fallback = setTimeout(() => {
      setSession((current) => (current === undefined ? null : current));
    }, 1500);
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch(() => setSession(null))
      .finally(() => clearTimeout(fallback));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) =>
      setSession(s)
    );
    return () => {
      clearTimeout(fallback);
      sub.subscription.unsubscribe();
    };
  }, []);

  const refreshUnread = useCallback(async () => {
    try {
      const me = await getMe();
      setUnread(me.unreadCount ?? 0);
    } catch {
      setUnread(0);
    }
  }, []);

  useEffect(() => {
    if (!session) return void setUnread(0);
    refreshUnread();
    const onFocus = () => refreshUnread();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [session, refreshUnread]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const signedIn = !!session;

  function navIconClass(active: boolean): string {
    return `flex items-center justify-center rounded-full bg-paper px-2.5 py-2.5 text-ink transition-colors hover:bg-white ${
      active ? "bg-white" : ""
    }`;
  }

  async function signOut() {
    await createClient().auth.signOut();
    setMenuOpen(false);
    router.replace("/");
    router.refresh();
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshUnread();
      router.refresh();
    } finally {
      // Keep the spin visible long enough to read as an intentional action,
      // even when the API returns instantly.
      setTimeout(() => setRefreshing(false), 400);
    }
  }

  return (
    <header className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      <div
        className={`flex origin-top items-center gap-2 rounded-full bg-ink text-paper transition-all duration-400 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none ${
          hidden
            ? "pointer-events-none -translate-y-[150%] scale-75 opacity-0"
            : "pointer-events-auto translate-y-0 scale-100 opacity-100"
        } ${
          scrolled
            ? "px-3 py-2 shadow-lg shadow-ink/25"
            : "px-4 py-2.5 shadow-md shadow-ink/10"
        }`}
      >
        <Link href="/" className="flex items-center pl-3 pr-16 sm:pr-24">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/wordmark.svg"
            alt="bullet"
            className="h-5 w-auto brightness-0 invert"
          />
        </Link>
        {signedIn && (
          <>
            <Link
              href="/send"
              aria-label="Send"
              title="Send"
              onClick={(e) => {
                if (pathname === "/send") {
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent("bullet:reset-send"));
                }
              }}
              className={navIconClass(pathname === "/send")}
            >
              <SendIcon className="h-4 w-4 translate-y-[1px] -translate-x-[1px]" />
            </Link>
            <Link
              href="/inbox"
              aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
              title="Inbox"
              className={`relative ${navIconClass(pathname === "/inbox")}`}
            >
              <InboxIcon className="h-4 w-4" />
              {unread > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-ink text-paper ring-2 ring-paper px-1 font-mono text-[10px]">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
            <div ref={menuRef} className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Menu"
                className="relative flex items-center rounded-full p-2 text-paper/80 transition-colors hover:bg-white/10 hover:text-paper"
              >
                <ChevronDownIcon
                  className={`h-4 w-4 transition-transform ${menuOpen ? "rotate-180" : ""}`}
                />
              </button>
              <div
                role="menu"
                className={`absolute right-0 top-full mt-2 min-w-44 origin-top-right overflow-hidden rounded-2xl border border-fog bg-white text-ink shadow-lg shadow-ink/10 transition-all duration-150 ease-out ${
                  menuOpen
                    ? "pointer-events-auto scale-100 opacity-100 translate-y-0"
                    : "pointer-events-none scale-95 opacity-0 -translate-y-1"
                }`}
              >
                <Link
                  href="/account"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="block px-4 py-2.5 text-sm font-medium hover:bg-paper"
                >
                  Account
                </Link>
                <button
                  onClick={refresh}
                  disabled={refreshing}
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium hover:bg-paper disabled:opacity-60"
                >
                  <RefreshIcon
                    className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                  />
                  Refresh
                </button>
                <button
                  onClick={signOut}
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  <LogOutIcon className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </div>
          </>
        )}
        {/* ponytail: undefined = loading, don't flash Sign in before we know;
            the effect above guarantees session settles to null or a real
            session within 1.5s, so this slot is never blank for long. */}
        {session === null && (
          <Link
            href="/register"
            className="rounded-full bg-paper px-3.5 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-white"
          >
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
