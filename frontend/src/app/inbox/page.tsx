import { Inbox } from "@/components/Inbox";

export const metadata = { title: "Inbox · bullet" };

export default function InboxPage() {
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Inbox</h1>
      <Inbox />
    </div>
  );
}
