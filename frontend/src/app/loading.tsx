import { Skeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <Skeleton className="h-10 w-40" />
      <div className="space-y-4 rounded-2xl border border-fog bg-white p-6">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-11 rounded-xl" />
        <Skeleton className="h-11 rounded-full" />
      </div>
    </div>
  );
}
