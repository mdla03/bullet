import { SendForm } from "@/components/SendForm";

export const metadata = { title: "Send · bullet" };

export default async function SendPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string }>;
}) {
  const { to } = await searchParams;
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-10 pt-4 text-center">
      <div className="space-y-4">
        <h1 className="text-5xl font-extrabold leading-[0.95] tracking-tighter sm:text-6xl">
          send.
          <br />
          silently.
        </h1>
        <p className="mx-auto max-w-sm text-base text-graphite">
          Pay any handle or email in USDC. Nothing on-chain links you to the
          recipient.
        </p>
      </div>
      <div className="w-full text-left">
        <SendForm initialRecipient={to} />
      </div>
    </div>
  );
}
