"use client";

import { useEffect, useRef, useState } from "react";

const HANDLE = "@maria";
const DENOMS = [1, 10, 50, 100];
const PICKED = 50;

const STEPS = [
  {
    title: "Type a handle.",
    body: "@maria or an email. Bullet resolves it to their keys. No wallet addresses exchanged.",
  },
  {
    title: "Pick an amount. Pay.",
    body: "Fixed sizes only (USDC or XLM), so no amount stands out. Sign once.",
  },
  {
    title: "A note appears on-chain.",
    body: "Only a commitment hash. The recipient claims it later with a zero-knowledge proof. No link back to you.",
  },
];

// Autoplays once when scrolled into view: types the handle, picks 50 USDC,
// presses Pay, slides the tx card in. Clicking a rail step replays from it.
export default function HowItWorks() {
  const ref = useRef<HTMLElement>(null);
  const [chars, setChars] = useState(0);
  const [denom, setDenom] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [cardIn, setCardIn] = useState(false);
  const [active, setActive] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const started = useRef(false);

  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const at = (ms: number, fn: () => void) =>
    timers.current.push(setTimeout(fn, ms));

  const play = (from: 0 | 1 | 2) => {
    clear();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setChars(HANDLE.length);
      setDenom(true);
      setPressed(false);
      setCardIn(true);
      setActive(2);
      return;
    }
    const amountThenPay = (t: number) => {
      at(t, () => setActive(1));
      at(t + 300, () => setDenom(true));
      at(t + 1100, () => setPressed(true));
      at(t + 1350, () => setPressed(false));
      at(t + 1900, () => {
        setActive(2);
        setCardIn(true);
      });
    };
    setPressed(false);
    if (from === 0) {
      setChars(0);
      setDenom(false);
      setCardIn(false);
      setActive(0);
      for (let i = 1; i <= HANDLE.length; i++) {
        at(400 + i * 130, () => setChars(i));
      }
      amountThenPay(400 + HANDLE.length * 130 + 500);
    } else if (from === 1) {
      setChars(HANDLE.length);
      setDenom(false);
      setCardIn(false);
      amountThenPay(200);
    } else {
      setChars(HANDLE.length);
      setDenom(true);
      setCardIn(false);
      setActive(2);
      at(150, () => setCardIn(true));
    }
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          play(0);
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typed = HANDLE.slice(0, chars);

  return (
    <section
      ref={ref}
      className="flex min-h-screen w-full flex-col justify-center"
    >
      <h2 className="text-left text-3xl font-bold tracking-tight sm:text-4xl">
        How it works
      </h2>

      <div className="mt-12 grid gap-12 text-left md:grid-cols-[300px_1fr] md:items-center">
        {/* Step rail; click a step to replay from there */}
        <div className="relative pl-6">
          <div className="absolute left-0 top-0 h-full w-px bg-fog" />
          <div
            className="absolute left-0 top-0 w-px bg-ink transition-all duration-500"
            style={{ height: `${((active + 1) / STEPS.length) * 100}%` }}
          />
          <ol className="space-y-10">
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <button
                  type="button"
                  onClick={() => play(i as 0 | 1 | 2)}
                  className={`text-left transition-opacity duration-300 hover:opacity-100 ${
                    i === active ? "opacity-100" : "opacity-40"
                  }`}
                >
                  <p className="font-mono text-sm text-graphite">0{i + 1}</p>
                  <p className="mt-1 text-xl font-semibold">{step.title}</p>
                  <p className="mt-2 text-graphite">{step.body}</p>
                </button>
              </li>
            ))}
          </ol>
        </div>

        {/* Stage */}
        <div
          className="flex flex-col items-center justify-center gap-10"
          aria-hidden
        >
          {/* Send box + denomination pills being driven by the demo */}
          <div
            className={`flex flex-col items-center gap-5 transition-opacity duration-300 ${
              active === 2 ? "opacity-40" : "opacity-100"
            }`}
          >
            <div className="flex w-full max-w-md items-center gap-2 sm:w-auto sm:max-w-none">
              <span className="flex min-w-0 flex-1 items-center rounded-full border border-fog bg-white px-5 py-3 text-lg sm:min-w-[340px] sm:flex-none sm:px-6 sm:py-4 sm:text-xl">
                {typed ? (
                  <span className="truncate">{typed}</span>
                ) : (
                  <span className="truncate text-graphite/60">
                    @handle or email
                  </span>
                )}
                <span
                  className={`ml-0.5 inline-block h-6 w-0.5 shrink-0 bg-ink ${
                    active === 2 ? "opacity-0" : "animate-pulse"
                  }`}
                />
              </span>
              <span
                className={`shrink-0 rounded-full bg-ink px-6 py-3 text-lg font-semibold text-paper transition-transform duration-200 sm:px-7 sm:py-4 sm:text-xl ${
                  pressed ? "scale-90" : "scale-100"
                }`}
              >
                Pay
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {DENOMS.map((d) => (
                <span
                  key={d}
                  className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-medium transition-all duration-300 sm:px-5 sm:py-2.5 sm:text-base ${
                    denom && d === PICKED
                      ? "scale-105 border-ink bg-ink text-paper"
                      : "border-fog bg-white text-graphite"
                  }`}
                >
                  {d} USDC
                </span>
              ))}
            </div>
          </div>

          {/* The tx: brand note card sliding in */}
          <div
            className={`w-[340px] rounded-2xl border border-fog bg-white p-7 shadow-sm transition-all duration-700 ease-out sm:w-[480px] sm:p-9 ${
              cardIn ? "translate-y-0 opacity-100" : "translate-y-12 opacity-0"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/wordmark.svg"
              alt="bullet"
              className="h-5 w-auto sm:h-6"
            />
            <p className="mt-8 text-5xl font-bold tracking-tight sm:text-6xl">
              50 USDC
            </p>
            <p className="mt-2 text-xl text-graphite">to @maria</p>
            <div className="mt-8 flex items-center justify-between gap-4 border-t border-fog pt-5">
              <p className="font-mono text-sm text-graphite">sent silently</p>
              <p className="font-mono text-sm text-graphite">
                0x9f3a41c7…c41d
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
