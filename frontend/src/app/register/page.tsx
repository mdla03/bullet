import { RegisterFlow } from "@/components/RegisterFlow";

export const metadata = { title: "Sign in · bullet" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; provider?: string; change?: string }>;
}) {
  const params = await searchParams;
  const autoProvider =
    params.provider === "google" || params.provider === "x"
      ? params.provider
      : undefined;
  const changeWallet = params.change === "1";

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-8 text-center text-3xl font-bold tracking-tight">
        {changeWallet ? "Change your wallet." : "Get paid with your handle."}
      </h1>
      <RegisterFlow
        oauthError={params.error}
        autoProvider={autoProvider}
        changeWallet={changeWallet}
      />
    </div>
  );
}
