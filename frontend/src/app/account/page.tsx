import { AccountView } from "@/components/AccountView";

export const metadata = { title: "Account · bullet" };

export default function AccountPage() {
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Account</h1>
      <AccountView />
    </div>
  );
}
