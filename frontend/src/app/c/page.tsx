import { ClaimView } from "@/components/ClaimView";

interface Props {
  searchParams: Promise<{ p?: string }>;
}

// Short claim route (/c). Newer links point here to stay compact; the older
// /claim route still works for previously minted links.
export default async function ShortClaimPage({ searchParams }: Props) {
  const { p } = await searchParams;
  return (
    <div className="mx-auto max-w-lg">
      <ClaimView encoded={p ?? ""} />
    </div>
  );
}
