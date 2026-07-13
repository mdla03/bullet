import { RegisterFlow } from "@/components/RegisterFlow";

export const metadata = { title: "Account · bullet" };

export default function AccountPage() {
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-2 text-2xl font-bold tracking-tight">Account</h1>
      <p className="mb-8 text-sm text-graphite">
        Manage your handles and wallet.
      </p>
      <RegisterFlow />
    </div>
  );
}
