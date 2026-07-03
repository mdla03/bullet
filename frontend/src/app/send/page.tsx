import { SendForm } from "@/components/SendForm";

export const metadata = { title: "Send · Bullet" };

export default function SendPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold tracking-tight">
        Send money to a handle
      </h1>
      <p className="mb-8 text-sm text-zinc-400">
        Pay any X handle or email in USDC. Nothing on-chain links you to the
        recipient. The payment lands as an anonymous note only they can claim.
      </p>
      <SendForm />
    </div>
  );
}
