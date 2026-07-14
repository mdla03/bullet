import { SendForm } from "@/components/SendForm";
import { SendHistory } from "@/components/SendHistory";
import { SentInvites } from "@/components/SentInvites";

export const metadata = { title: "Send · bullet" };

export default async function SendPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string }>;
}) {
  const { to } = await searchParams;
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Send</h1>
      <SendForm initialRecipient={to} />
      <SentInvites />
      <SendHistory />
    </div>
  );
}
