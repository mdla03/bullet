import { ClaimView } from "@/components/ClaimView";

interface Props {
  searchParams: Promise<{ p?: string }>;
}

export default async function ClaimPage({ searchParams }: Props) {
  const { p } = await searchParams;
  return (
    <div className="mx-auto max-w-lg">
      <ClaimView encoded={p ?? ""} />
    </div>
  );
}
