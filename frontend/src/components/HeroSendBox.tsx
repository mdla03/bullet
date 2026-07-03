"use client";

import { useEffect, useState } from "react";

const SAMPLES = ["@maria", "kyle@gmail.com", "@stellar_dev"];

export default function HeroSendBox() {
  const [placeholder, setPlaceholder] = useState("@handle or email");

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let word = 0;
    let len = 0;
    let deleting = false;
    let t: ReturnType<typeof setTimeout>;

    const step = () => {
      const sample = SAMPLES[word];
      if (!deleting && len < sample.length) {
        len += 1;
      } else if (!deleting) {
        deleting = true;
        t = setTimeout(step, 1800);
        return;
      } else if (len > 0) {
        len -= 1;
      } else {
        deleting = false;
        word = (word + 1) % SAMPLES.length;
      }
      setPlaceholder(sample.slice(0, len));
      t = setTimeout(step, deleting ? 40 : 90);
    };

    t = setTimeout(step, 1200);
    return () => clearTimeout(t);
  }, []);

  return (
    <form action="/send" method="get" className="mx-auto flex w-full max-w-md gap-2">
      <input
        type="text"
        name="to"
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-full border border-fog bg-white px-5 py-3.5 text-lg placeholder-graphite/60 focus:border-ink focus:outline-none"
      />
      <button
        type="submit"
        className="shrink-0 rounded-full bg-ink px-7 py-3.5 text-lg font-semibold text-paper transition hover:-translate-y-0.5 hover:bg-ink/85 active:translate-y-0"
      >
        Pay
      </button>
    </form>
  );
}
