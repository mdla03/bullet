// Browser-side Groth16 prover. Mirrors backend/src/prove.ts byte layout so the
// on-chain verifier accepts the resulting proof.
//
// Flow: client already has {secret, recipientDigest, amount, tokenId} from the claim link.
// (1) Compute commitment = Poseidon([secret, recipientDigest, amount, tokenId]).
// (2) Ask resolver for the Merkle path against the current tree.
// (3) Compute nullifier = Poseidon([secret]) so the secret never leaves the tab.
// (4) Run snarkjs.groth16.fullProve locally against claim.wasm + claim.zkey.
// (5) Format proof bytes for Soroban (matches backend byte layout).

// @ts-expect-error — snarkjs has no bundled types.
import * as snarkjs from "snarkjs";
import { poseidon } from "./poseidon";

const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";
const WASM_URL = "/circuits/claim.wasm";
const ZKEY_URL = "/circuits/claim.zkey";

export interface BrowserProveResult {
  proof_a: string;   // 192-char hex (G1)
  proof_b: string;   // 384-char hex (G2)
  proof_c: string;   // 192-char hex (G1)
  nullifier: string; // 64-char hex (Fr)
  root: string;      // 64-char hex (Fr)
}

let cachedAssets: { wasm: Uint8Array; zkey: Uint8Array } | null = null;

async function loadAssets(): Promise<{ wasm: Uint8Array; zkey: Uint8Array }> {
  if (cachedAssets) return cachedAssets;
  const [wasmRes, zkeyRes] = await Promise.all([
    fetch(WASM_URL),
    fetch(ZKEY_URL),
  ]);
  if (!wasmRes.ok) throw new Error(`Failed to load claim.wasm (${wasmRes.status})`);
  if (!zkeyRes.ok) throw new Error(`Failed to load claim.zkey (${zkeyRes.status})`);
  const [wasm, zkey] = await Promise.all([
    wasmRes.arrayBuffer(),
    zkeyRes.arrayBuffer(),
  ]);
  cachedAssets = { wasm: new Uint8Array(wasm), zkey: new Uint8Array(zkey) };
  return cachedAssets;
}

function be(dec: string, bytes: number): string {
  const h = BigInt(dec).toString(16);
  if (h.length > bytes * 2) throw new Error(`value overflow: ${dec}`);
  return h.padStart(bytes * 2, "0");
}

const g1 = (pt: [string, string, string]): string => be(pt[0], 48) + be(pt[1], 48);
const g2 = (pt: [[string, string], [string, string], [string, string]]): string =>
  be(pt[0][1], 48) + be(pt[0][0], 48) + be(pt[1][1], 48) + be(pt[1][0], 48);
const fr = (dec: string): string => be(dec, 32);

/**
 * Generate a Groth16 proof for a claim in the browser.
 *
 * @param secretDec  decimal string of the secret (BigInt("0x"+hex).toString() from the link)
 * @param recipientDigest decimal string from the claim link
 * @param amount decimal string of the stroop amount (e.g. "100000000" for 10 USDC)
 * @param tokenId token identifier string ("0" = USDC, "1" = XLM)
 * @param onStage optional callback receiving 'loading' | 'proving' for UI hooks
 */
export async function proveBrowser(
  secretDec: string,
  recipientDigest: string,
  amount: string,
  tokenId: string = "0",
  onStage?: (stage: "loading" | "path" | "proving") => void
): Promise<BrowserProveResult> {
  onStage?.("loading");
  const [{ wasm, zkey }, commitment] = await Promise.all([
    loadAssets(),
    Promise.resolve(poseidon([secretDec, recipientDigest, amount, tokenId])),
  ]);

  onStage?.("path");
  const pathRes = await fetch(
    `${RESOLVER_URL}/path?commitment=${encodeURIComponent(commitment)}`
  );
  if (!pathRes.ok) {
    const err = (await pathRes.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      `Merkle path lookup failed: ${err.detail ?? pathRes.status}`
    );
  }
  const { root, pathElements, pathIndices } = (await pathRes.json()) as {
    root: string;
    pathElements: string[];
    pathIndices: number[];
  };

  const nullifier = poseidon([secretDec]);

  onStage?.("proving");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      root,
      nullifier,
      recipientDigest,
      amount,
      tokenId,
      secret: secretDec,
      pathElements,
      pathIndices,
    },
    wasm,
    zkey
  );

  void publicSignals;

  return {
    proof_a: g1(proof.pi_a),
    proof_b: g2(proof.pi_b),
    proof_c: g1(proof.pi_c),
    nullifier: fr(nullifier),
    root: fr(root),
  };
}
