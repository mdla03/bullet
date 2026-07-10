import { RegisterFlow } from "@/components/RegisterFlow";

export const metadata = { title: "Sign in · bullet" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; provider?: string }>;
}) {
  const params = await searchParams;
  const autoProvider =
    params.provider === "google" || params.provider === "x"
      ? params.provider
      : undefined;

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-2 text-2xl font-bold tracking-tight">
        Get paid with your handle
      </h1>
      <p className="mb-8 text-sm text-graphite">
        Sign in once and attach your wallet. After that, anyone can pay you by
        typing your handle, and each payment arrives as a private note only
        you can claim.
      </p>
      <RegisterFlow oauthError={params.error} autoProvider={autoProvider} />
    </div>
  );
}
