import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60svh] max-w-3xl flex-col items-center justify-center text-center">
      <p className="text-[10rem] font-extrabold leading-none tracking-tighter sm:text-[16rem]">
        404
      </p>
      <p className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
        Page not found
      </p>
      <p className="mt-3 max-w-md text-sm text-graphite">
        The link you followed may be broken, or the page has moved.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center justify-center rounded-full bg-ink px-8 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
      >
        Back home
      </Link>
    </div>
  );
}
