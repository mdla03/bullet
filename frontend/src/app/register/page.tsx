import { RegisterFlow } from "@/components/RegisterFlow";

export const metadata = { title: "Sign in · bullet" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; provider?: string; preview?: string }>;
}) {
  const params = await searchParams;
  const autoProvider =
    params.provider === "google" || params.provider === "x"
      ? params.provider
      : undefined;
  // ponytail: preview=inbox|sent|oauth|wallet|confirm|done skips real auth and
  // renders that specific step with mock data. Dev-only aid; keep in sync
  // when RegisterFlow states change.
  const preview =
    params.preview &&
    ["inbox", "sent", "oauth", "wallet", "confirm", "done"].includes(params.preview)
      ? (params.preview as "inbox" | "sent" | "oauth" | "wallet" | "confirm" | "done")
      : undefined;

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-8 text-center text-3xl font-bold tracking-tight">
        Get paid with your handle.
      </h1>
      <RegisterFlow
        oauthError={params.error}
        autoProvider={autoProvider}
        preview={preview}
      />
    </div>
  );
}
