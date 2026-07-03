import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center gap-14 py-10 text-center">
      {/* Hero */}
      <div className="max-w-3xl space-y-6">
        <h1 className="text-5xl font-bold leading-[1.05] tracking-tight sm:text-7xl">
          payments without a trace.
        </h1>
        <p className="mx-auto max-w-xl text-lg text-graphite">
          Send USDC to any X handle or email. Fixed-size notes and
          zero-knowledge proofs mean nothing on-chain connects you to the
          recipient.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/register"
            className="rounded-full bg-ink px-6 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
          >
            Get paid with your handle
          </Link>
          <Link
            href="/send"
            className="rounded-full border border-fog bg-white px-6 py-3 font-semibold transition-colors hover:border-graphite"
          >
            Send money
          </Link>
        </div>
      </div>

      {/* UI preview card, per the brand sheet */}
      <div className="w-full max-w-sm rounded-2xl border border-fog bg-white p-6 text-left shadow-sm">
        <p className="text-sm font-bold tracking-tight">bullet</p>
        <p className="mt-5 text-5xl font-bold tracking-tight">50 USDC</p>
        <p className="mt-1 text-graphite">to @kyle</p>
        <p className="mt-6 flex items-center gap-2 font-mono text-sm text-signal">
          <span className="inline-block h-2 w-2 rounded-full bg-signal" />
          sent silently
        </p>
      </div>

      {/* How it stays private */}
      <div className="grid max-w-3xl gap-6 text-left sm:grid-cols-3">
        <div>
          <p className="font-semibold">fast.</p>
          <p className="mt-1 text-sm text-graphite">
            Type a handle, pick an amount, sign once. No wallet addresses
            exchanged.
          </p>
        </div>
        <div>
          <p className="font-semibold">small.</p>
          <p className="mt-1 text-sm text-graphite">
            Every payment is a fixed-size note of 1, 10, 50 or 100 USDC, so no
            amount stands out.
          </p>
        </div>
        <div>
          <p className="font-semibold">silent.</p>
          <p className="mt-1 text-sm text-graphite">
            The recipient claims with a zero-knowledge proof. No on-chain field
            links their claim to your deposit.
          </p>
        </div>
      </div>
    </div>
  );
}
