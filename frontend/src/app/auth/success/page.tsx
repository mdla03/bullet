import Link from "next/link";
import { CheckIcon } from "@/components/icons";

export const metadata = { title: "Signed in · bullet" };

export default function AuthSuccessPage() {
  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-fog bg-white p-8 text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-signal/10">
          <CheckIcon className="h-6 w-6 text-signal" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Signed in</h1>
        <p className="mt-2 text-sm text-graphite">
          You can close this tab and return to the window where you started.
        </p>
        <Link
          href="/register"
          className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-ink px-5 py-3 font-semibold text-paper transition-colors hover:bg-ink/85"
        >
          Continue in this tab
        </Link>
      </div>
    </div>
  );
}
