import Link from "next/link";
import { XBrandIcon } from "@/components/icons";

export default function Home() {
  return (
    <div className="flex flex-col items-center gap-16 py-12 text-center">
      {/* Hero */}
      <div className="w-full max-w-3xl space-y-8">
        <h1 className="text-6xl font-extrabold leading-[0.95] tracking-tighter sm:text-8xl">
          send money.
          <br />
          leave no trace.
        </h1>
        <p className="mx-auto max-w-xl text-lg text-graphite">
          Pay any X handle or email in USDC. Nothing on-chain connects you to
          them.
        </p>

        {/* The real send box. Submits straight into the send flow. */}
        <form
          action="/send"
          method="get"
          className="mx-auto flex w-full max-w-md gap-2"
        >
          <input
            type="text"
            name="to"
            placeholder="@handle or email"
            autoComplete="off"
            className="w-full rounded-full border border-fog bg-white px-5 py-3.5 text-lg placeholder-graphite/60 focus:border-ink focus:outline-none"
          />
          <button
            type="submit"
            className="shrink-0 rounded-full bg-ink px-7 py-3.5 text-lg font-semibold text-paper transition-colors hover:bg-ink/85"
          >
            Pay
          </button>
        </form>

        <p className="flex items-center justify-center gap-2 text-sm text-graphite">
          Getting paid instead?
          <Link
            href="/register"
            className="inline-flex items-center gap-2 rounded-full border border-fog bg-white px-4 py-2 font-medium text-ink transition-colors hover:border-graphite"
          >
            <XBrandIcon className="h-4 w-4" />
            Continue with X
          </Link>
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
