// D1 evidence: in-browser proving-time benchmark for the 7-public-input
// claim circuit (root, nullifier, recipientDigest, amount, tokenId,
// amountCommitmentX, amountCommitmentY).
//
// Local only. notFound() in production so this never ships on sendbullet.xyz.
//
// Artifacts are gitignored. Before running `pnpm dev`, copy them in:
//
//   mkdir -p frontend/public/circuits/bench
//   cp circuits/build/claim_js/claim.wasm circuits/build/claim.zkey \
//      circuits/build/claim_input.json circuits/build/claim_vk.json \
//      frontend/public/circuits/bench/
//
// These live under /circuits/bench/ on purpose, kept separate from the
// production prover's own copy (src/lib/prove_browser.ts reads
// /circuits/claim.wasm and /circuits/claim.zkey directly) so a bench run
// never depends on, or risks disturbing, the artifacts a live claim uses.

import { notFound } from "next/navigation";
import Bench from "./bench-client";

// Evaluate the guard per request. Without this Next prerenders the route at
// build time, bakes the not-found page as static output, and serves it with
// HTTP 200 instead of a real 404.
export const dynamic = "force-dynamic";

export default function BenchPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Bench />;
}
