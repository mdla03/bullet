import { SendForm } from "@/components/SendForm";

export const metadata = { title: "Send — ZeekPay" };

export default function SendPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">Send a private note</h1>
      <p className="mb-8 text-sm text-gray-400">
        The recipient only sees the amount — not who sent it.
      </p>
      <SendForm />
    </div>
  );
}
