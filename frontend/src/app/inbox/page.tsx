import { Inbox } from "@/components/Inbox";

export const metadata = { title: "Inbox · bullet" };

export default function InboxPage() {
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-2 text-2xl font-bold tracking-tight">Your inbox</h1>
      <p className="mb-8 text-sm text-graphite">
        Payments to your handle arrive here as private notes. Unlock with your
        wallet to see and claim them.
      </p>
      <Inbox />
    </div>
  );
}
