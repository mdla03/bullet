"use client";

import { useEffect, useState } from "react";
import { SendForm } from "@/components/SendForm";

/** Remounts SendForm on "bullet:reset-send" (dispatched by IslandNav's Send
 *  nav icon when you're already on /send) by bumping a key, so the form goes
 *  back to empty without a page navigation or URL param. Same idiom as
 *  SendHistory's "bullet:send-complete" listener. */
export function SendFormHost(props: { initialRecipient?: string }) {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const onReset = () => setEpoch((e) => e + 1);
    window.addEventListener("bullet:reset-send", onReset);
    return () => window.removeEventListener("bullet:reset-send", onReset);
  }, []);

  return <SendForm key={epoch} {...props} />;
}
