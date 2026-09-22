"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "@/components/icons";

/**
 * Renders a short, factual error line. When `details` is given (the raw
 * exception/HostError/diagnostic-event text), a "Show details" pill expands
 * a scrollable monospace panel with the full log and a "Copy log" pill,
 * instead of dumping thousands of characters inline.
 */
export function ErrorDetails({
  message,
  details,
}: {
  message: string;
  details?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
    };
  }, []);

  function copyLog() {
    if (!details) return;
    navigator.clipboard.writeText(details);
    setCopied(true);
    if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
    copiedTimeout.current = setTimeout(() => {
      setCopied(false);
      copiedTimeout.current = null;
    }, 2000);
  }

  return (
    <div>
      <p>{message}</p>
      {details && (
        <div className="mt-2 space-y-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex items-center gap-1 rounded-full border border-fog px-3 py-1.5 text-sm text-graphite transition-colors hover:border-graphite hover:text-ink"
          >
            {open ? "Hide details" : "Show details"}
            <ChevronDownIcon
              className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
          {open && (
            <div className="space-y-2">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-fog bg-paper p-3 font-mono text-xs text-graphite">
                {details}
              </pre>
              <button
                type="button"
                onClick={copyLog}
                className="flex items-center gap-1 rounded-full border border-fog px-3 py-1.5 text-sm text-graphite transition-colors hover:border-graphite hover:text-ink"
              >
                {copied ? (
                  <CheckIcon className="h-3.5 w-3.5" />
                ) : (
                  <CopyIcon className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied" : "Copy log"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
