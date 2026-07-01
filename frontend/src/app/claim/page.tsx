import { ClaimView } from "@/components/ClaimView";

interface Props {
  searchParams: Promise<{ p?: string }>;
}

export default async function ClaimPage({ searchParams }: Props) {
  const { p } = await searchParams;
  return <ClaimView encoded={p ?? ""} />;
}
