"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "@/components/icons";

const STEPS = [
  {
    title: "Type a handle.",
    body: "Pay @maria or an email address. Bullet resolves it to their keys. No wallet addresses exchanged.",
  },
  {
    title: "A note goes on-chain.",
    body: "Your USDC becomes a fixed-size note of 1, 10, 50 or 100. To anyone watching, it is only a commitment hash.",
  },
  {
    title: "They claim with a proof.",
    body: "The recipient proves a note is theirs with a zero-knowledge proof. Nothing on-chain links their claim to your deposit.",
  },
];

const CARD =
  "w-[340px] rounded-2xl border border-fog bg-white p-7 text-left shadow-sm sm:w-[420px] sm:p-8";

// Scroll-driven story: the section is 3 screens tall, the panel is sticky,
// and scroll progress picks which step is on stage.
export default function HowItWorks() {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const el = ref.current;
      if (!el) return;
      const total = el.offsetHeight - window.innerHeight;
      const p = Math.min(0.999, Math.max(0, -el.getBoundingClientRect().top / total));
      setActive(Math.floor(p * STEPS.length));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /* eslint-disable @next/next/no-img-element */
  const visuals = [
    // 01: the note card from the brand sheet
    <div key="send" className={CARD}>
      <img src="/wordmark.svg" alt="bullet" className="h-4 w-auto" />
      <p className="mt-7 text-5xl font-bold tracking-tight sm:text-6xl">
        50 USDC
      </p>
      <p className="mt-2 text-lg text-graphite">to @maria</p>
      <div className="mt-7 border-t border-fog pt-5">
        <p className="font-mono text-sm text-graphite">sent silently</p>
      </div>
    </div>,
    // 02: the same payment as the chain records it
    <div key="note" className={CARD}>
      <p className="font-mono text-sm text-graphite">on-chain record</p>
      <p className="mt-7 break-all font-mono text-3xl text-ink sm:text-4xl">
        0x9f3a41c7…c41d
      </p>
      <p className="mt-2 text-lg text-graphite">
        a 50 USDC note, identical to every other
      </p>
      <div className="mt-7 border-t border-fog pt-5">
        <p className="font-mono text-sm text-graphite">
          no sender. no recipient.
        </p>
      </div>
    </div>,
    // 03: claimed on the other side
    <div key="claim" className={CARD}>
      <img src="/wordmark.svg" alt="bullet" className="h-4 w-auto" />
      <p className="mt-7 flex items-center gap-4 text-5xl font-bold tracking-tight sm:text-6xl">
        50 USDC
        <CheckIcon className="h-9 w-9 shrink-0 text-signal" />
      </p>
      <p className="mt-2 text-lg text-graphite">claimed by @maria</p>
      <div className="mt-7 border-t border-fog pt-5">
        <p className="font-mono text-sm text-graphite">no link back</p>
      </div>
    </div>,
  ];
  /* eslint-enable @next/next/no-img-element */

  const stage = (i: number) =>
    i === active
      ? "translate-y-0 opacity-100"
      : i < active
        ? "-translate-y-10 opacity-0"
        : "translate-y-10 opacity-0";

  return (
    <section ref={ref} className="relative h-[300vh] w-full">
      <div className="sticky top-0 flex h-screen flex-col items-center justify-center gap-10">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          how it works.
        </h2>

        <div className="relative h-[280px] w-full sm:h-[310px]">
          {visuals.map((visual, i) => (
            <div
              key={i}
              className={`absolute inset-0 flex items-center justify-center transition-all duration-500 ease-out motion-reduce:transition-none ${stage(i)}`}
            >
              {visual}
            </div>
          ))}
        </div>

        <div className="relative h-36 w-full max-w-lg">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className={`absolute inset-0 transition-all duration-500 ease-out motion-reduce:transition-none ${stage(i)}`}
            >
              <p className="font-mono text-sm text-graphite">
                0{i + 1} <span className="text-graphite/40">/ 03</span>
              </p>
              <p className="mt-2 text-xl font-semibold">{step.title}</p>
              <p className="mt-2 text-graphite">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
