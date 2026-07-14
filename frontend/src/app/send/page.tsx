import { SendForm } from "@/components/SendForm";
import { SentInvites } from "@/components/SentInvites";

export const metadata = { title: "Send · bullet" };

export default async function SendPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string }>;
}) {
  const { to } = await searchParams;
  return (
    <div className="mx-auto max-w-sm space-y-8">
      <SendForm initialRecipient={to} />
      <SentInvites />
    </div>
  );
}
