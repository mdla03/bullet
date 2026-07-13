"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export default function IslandNav() {
  const [scrolled, setScrolled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const lastY = useRef(0);
  const router = useRouter();

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
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) =>
      setSession(s)
    );
    return () => sub.subscription.unsubscribe();
  }, []);

  const signedIn = !!session;

  async function signOut() {
    await createClient().auth.signOut();
    // Force every page (Inbox, Send, etc.) to remount so their auth-dependent
    // state clears. Just nulling `session` doesn't tell child pages to reset.
    router.replace("/");
    router.refresh();
  }

  return (
    <header className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      <div
        className={`flex origin-top items-center gap-1 rounded-full bg-ink text-paper transition-all duration-400 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none ${
          hidden
            ? "pointer-events-none -translate-y-[150%] scale-75 opacity-0"
            : "pointer-events-auto translate-y-0 scale-100 opacity-100"
        } ${
          scrolled
            ? "px-2.5 py-2 shadow-lg shadow-ink/25"
            : "px-4 py-2.5 shadow-md shadow-ink/10"
        }`}
      >
        <Link href="/" className="flex items-center pl-2 pr-4 sm:pr-8">
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
              className="rounded-full px-2 py-1.5 text-xs font-medium text-paper/80 transition-colors hover:bg-white/10 hover:text-paper sm:px-3 sm:text-sm"
            >
              Send
            </Link>
            <Link
              href="/inbox"
              className="rounded-full px-2 py-1.5 text-xs font-medium text-paper/80 transition-colors hover:bg-white/10 hover:text-paper sm:px-3 sm:text-sm"
            >
              Inbox
            </Link>
            <Link
              href="/account"
              className="rounded-full px-2 py-1.5 text-xs font-medium text-paper/80 transition-colors hover:bg-white/10 hover:text-paper sm:px-3 sm:text-sm"
            >
              Account
            </Link>
            <button
              onClick={signOut}
              className="rounded-full px-2 py-1.5 text-xs font-medium text-paper/60 transition-colors hover:bg-white/10 hover:text-paper sm:px-3 sm:text-sm"
            >
              Sign out
            </button>
          </>
        )}
        {/* ponytail: undefined = loading; don't flash Sign in before we know. */}
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
