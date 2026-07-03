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

  const visuals = [
    <div key="pay" className="flex items-center gap-2">
      <span className="rounded-full border border-fog bg-white px-6 py-3.5 font-mono text-lg">
        @maria
      </span>
      <span className="rounded-full bg-ink px-6 py-3.5 text-lg font-semibold text-paper">
        Pay
      </span>
    </div>,
    <span
      key="note"
      className="rounded-xl border border-fog bg-white px-6 py-4 font-mono text-lg"
    >
      10 USDC <span className="text-graphite">· 0x9f3a41c7…c41d</span>
    </span>,
    <span
      key="claim"
      className="flex items-center gap-2 rounded-full border border-fog bg-white px-6 py-3.5 text-lg font-semibold"
    >
      <CheckIcon className="h-5 w-5 text-signal" />
      claimed. no link back.
    </span>,
  ];

  const stage = (i: number) =>
    i === active
      ? "translate-y-0 opacity-100"
      : i < active
        ? "-translate-y-8 opacity-0"
        : "translate-y-8 opacity-0";

  return (
    <section ref={ref} className="relative h-[300vh] w-full">
      <div className="sticky top-0 flex h-screen flex-col items-center justify-center gap-12">
        <h2 className="text-2xl font-bold tracking-tight">how it works.</h2>

        <div className="relative h-20 w-full">
          {visuals.map((visual, i) => (
            <div
              key={i}
              className={`absolute inset-0 flex items-center justify-center transition-all duration-500 ease-out motion-reduce:transition-none ${stage(i)}`}
            >
              {visual}
            </div>
          ))}
        </div>

        <div className="relative h-32 w-full max-w-md">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className={`absolute inset-0 transition-all duration-500 ease-out motion-reduce:transition-none ${stage(i)}`}
            >
              <p className="font-mono text-sm text-graphite">
                0{i + 1} <span className="text-graphite/40">/ 03</span>
              </p>
              <p className="mt-2 font-semibold">{step.title}</p>
              <p className="mt-1 text-sm text-graphite">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
