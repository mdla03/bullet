import PoolWallet from "@/components/PoolWallet";

export const metadata = { title: "Pool · bullet" };

export default function PoolPage() {
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Pool</h1>
      <p className="text-sm text-graphite">
        Shield funds, then pay from them with the amount hidden on-chain.
      </p>
      <PoolWallet />
    </div>
  );
}
