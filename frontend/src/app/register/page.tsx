import { RegisterFlow } from "@/components/RegisterFlow";

export const metadata = { title: "Create account · Bullet" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; handle?: string; error?: string }>;
}) {
  const params = await searchParams;
  const successHandle =
    params.success === "1" && params.handle ? params.handle : undefined;

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold tracking-tight">
        Get paid with your handle
      </h1>
      <p className="mb-8 text-sm text-zinc-400">
        Link a handle to your wallet once. After that, anyone can pay you by
        typing it, and each payment arrives as a private note only you can
        claim.
      </p>
      <RegisterFlow successHandle={successHandle} oauthError={params.error} />
    </div>
  );
}
