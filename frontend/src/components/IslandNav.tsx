"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export default function IslandNav() {
  const [scrolled, setScrolled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 12);
      // Down past the hero: tuck away. Any upward scroll: pop back.
      setHidden(y > 120 && y > lastY.current);
      lastY.current = y;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
        <Link href="/" className="flex items-center pl-1 pr-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/wordmark.svg"
            alt="bullet"
            className="h-5 w-auto brightness-0 invert"
          />
        </Link>
        <Link
          href="/send"
          className="rounded-full px-3 py-1.5 text-sm font-medium text-paper/80 transition-colors hover:bg-white/10 hover:text-paper"
        >
          Send money
        </Link>
        <Link
          href="/register"
          className="rounded-full bg-paper px-3.5 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-white"
        >
          Sign up
        </Link>
      </div>
    </header>
  );
}
