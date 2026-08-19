// D1 evidence: in-browser proving-time benchmark for the 6-public-input
// claim circuit (root, nullifier, recipientDigest, amount, tokenId,
// amountCommitment).
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
// These live under /circuits/bench/ on purpose. The production prover
// (src/lib/prove_browser.ts) reads /circuits/claim.wasm and /circuits/claim.zkey,
// which are still the 5-input build the deployed contract expects. Overwriting
// those would make every live claim fail verification, since verifier::verify
// rejects any vk whose IC length does not match the public-input count.

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
