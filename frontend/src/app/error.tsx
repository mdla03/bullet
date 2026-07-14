"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error boundary]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-fog bg-white p-8 text-center">
        <p className="font-medium">Something broke</p>
        <p className="mt-1 text-sm text-graphite">
          The page hit an error we didn&apos;t expect. Try again, or head home
          and start fresh.
        </p>
        {error.digest && (
          <p className="mt-4 break-all font-mono text-xs text-graphite/70">
            {error.digest}
          </p>
        )}
        <div className="mt-6 flex flex-col gap-2">
          <button
            onClick={reset}
            className="flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
          >
            Try again
          </button>
          <Link
            href="/"
            className="flex w-full items-center justify-center rounded-full border border-fog bg-white px-5 py-3 font-medium transition-colors hover:border-graphite"
          >
            Back home
          </Link>
        </div>
      </div>
    </div>
  );
}
