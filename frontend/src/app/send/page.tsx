import { SendForm } from "@/components/SendForm";

export const metadata = { title: "Send · bullet" };

export default async function SendPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string }>;
}) {
  const { to } = await searchParams;
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-2 text-2xl font-bold tracking-tight">
        Send money to a handle
      </h1>
      <p className="mb-8 text-sm text-graphite">
        Pay any X handle or email in USDC. Nothing on-chain links you to the
        recipient. The payment lands as an anonymous note only they can claim.
      </p>
      <SendForm initialRecipient={to} />
    </div>
  );
}
