import { SendFormHost } from "@/components/SendFormHost";
import { SendHistory } from "@/components/SendHistory";

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
      <SendFormHost initialRecipient={to} />
      <SendHistory />
    </div>
  );
}
