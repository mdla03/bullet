import { RegisterFlow } from "@/components/RegisterFlow";
import { asOAuthProviderId } from "@zeekpay/shared";

export const metadata = { title: "Sign in · bullet" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; provider?: string; change?: string }>;
}) {
  const params = await searchParams;
  // ?provider= is untrusted; the registry decides which ids are real.
  const autoProvider = asOAuthProviderId(params.provider);
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
