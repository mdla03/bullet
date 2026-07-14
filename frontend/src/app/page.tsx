import Link from "next/link";
import HeroSendBox from "@/components/HeroSendBox";
import HowItWorks from "@/components/HowItWorks";
import Reveal from "@/components/Reveal";
import { GoogleIcon, XBrandIcon } from "@/components/icons";
import { createClient } from "@/lib/supabase/server";

// ponytail: sample commitments, purely illustrative. Real ones are Poseidon hashes.
const SAMPLE_NOTES = [
  { amount: 10, hash: "9f3a41c7…c41d" },
  { amount: 1, hash: "b7e208aa…08aa" },
  { amount: 50, hash: "4d917f3e…7f3e" },
  { amount: 10, hash: "e05cb912…b912" },
  { amount: 100, hash: "77a8d4c6…d4c6" },
  { amount: 50, hash: "c2f031be…31be" },
];

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const signedIn = !!user;
  return (
    <div className="flex flex-col items-center gap-20 text-center">
      {/* Hero: fills the first screen (minus the fixed nav offset) and centers */}
      <div className="flex min-h-[calc(100svh-7rem)] w-full max-w-3xl flex-col justify-center space-y-8">
        <h1 className="animate-rise text-6xl font-extrabold leading-[0.95] tracking-tighter sm:text-8xl">
          send money.
          <br />
          leave no trace.
        </h1>
        <p className="animate-rise mx-auto max-w-xl text-lg text-graphite [animation-delay:100ms]">
          Pay any X handle or email in USDC. Nothing on-chain connects you to
          them.
        </p>

        {/* The real send box + sign-in CTA grouped so they sit close together */}
        <div className="animate-rise flex flex-col items-center gap-5 [animation-delay:200ms]">
          <HeroSendBox />
          {!signedIn && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-graphite">Getting paid instead?</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Link
                href="/register?provider=google"
                className="inline-flex items-center gap-2 rounded-full border border-fog bg-white px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-graphite"
              >
                <GoogleIcon className="h-4 w-4" />
                Continue with Google
              </Link>
              <Link
                href="/register?provider=x"
                className="inline-flex items-center gap-2 rounded-full border border-fog bg-white px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-graphite"
              >
                <XBrandIcon className="h-4 w-4" />
                Continue with X
              </Link>
            </div>
          </div>
          )}
        </div>
      </div>

      {/* How it works: scroll story from pay link to claimed */}
      <HowItWorks />

      {/* What the chain sees */}
      <Reveal className="w-full max-w-4xl pb-24">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          what the chain sees.
        </h2>
        <div className="relative mt-10 overflow-hidden">
          <div className="animate-drift flex w-max motion-reduce:animate-none">
            {[...SAMPLE_NOTES, ...SAMPLE_NOTES].map((note, i) => (
              <div
                key={i}
                className="mr-4 w-60 shrink-0 rounded-2xl border border-fog bg-white p-6 text-left"
              >
                <p className="text-2xl font-bold tracking-tight">
                  {note.amount} USDC
                </p>
                <p className="mt-2 truncate font-mono text-sm text-graphite">
                  0x{note.hash}
                </p>
              </div>
            ))}
          </div>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-paper to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-paper to-transparent" />
        </div>
        <p className="mx-auto mt-8 max-w-xl text-graphite">
          Every deposit is a note of 1, 10, 50 or 100 USDC and a commitment
          hash. One of these could be yours. Nothing connects a deposit to the
          claim that spends it.
        </p>
      </Reveal>
    </div>
  );
}
