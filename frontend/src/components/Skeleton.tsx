export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-fog/70 motion-reduce:animate-none ${className}`}
      aria-hidden
    />
  );
}
