// Browser-side Groth16 provers for claim.circom and joinsplit.circom. Proof
// bytes are laid out the way the contract's verifier reads them.
//
// Claim flow: client already has {secret, recipientDigest, amount, tokenId} from the claim link.
// (1) Compute commitment = Poseidon([secret, recipientDigest, amount, tokenId]).
// (2) Ask resolver for the Merkle path and the note's leafIndex.
// (3) Compute nullifier = Poseidon([secret, leafIndex]) so the secret never leaves the tab.
// (4) Run snarkjs.groth16.fullProve locally against claim.wasm + claim.zkey.
// (5) Format proof bytes for Soroban.
//
// Send flow: proveSend() runs a witness from joinsplit.ts against
// joinsplit.wasm + joinsplit.zkey.

// @ts-expect-error — snarkjs has no bundled types.
import * as snarkjs from "snarkjs";
import { poseidon } from "./poseidon";
import { commit as pedersenCommit, BLINDING_BITS } from "./jubjub_commit";
import { noteNullifier } from "./commitment";

const RESOLVER_URL =
  process.env.NEXT_PUBLIC_RESOLVER_URL ?? "http://localhost:3001";

export interface BrowserProveResult {
  proof_a: string;   // 192-char hex (G1)
  proof_b: string;   // 384-char hex (G2)
  proof_c: string;   // 192-char hex (G1)
  nullifier: string; // 64-char hex (Fr)
  root: string;      // 64-char hex (Fr)
  amountCommitmentX: string; // 64-char hex (Fr)
  amountCommitmentY: string; // 64-char hex (Fr)
}

// Blinding is sampled uniformly on [0, 2^BLINDING_BITS), matching
// circuits/scripts/jubjub-ref.mjs randomBlinding: 32 random bytes with the
// top bits beyond BLINDING_BITS cleared. It never leaves the tab.
const BLINDING_BYTES = 32;
// Mask for the most-significant sampled byte: clearing the high
// (BLINDING_BYTES * 8 - BLINDING_BITS) bits leaves exactly BLINDING_BITS bits set.
const BLINDING_TOP_BYTE_MASK = 0xff >> (BLINDING_BYTES * 8 - Number(BLINDING_BITS));

function randomBlindingDec(): string {
  const bytes = new Uint8Array(BLINDING_BYTES);
  crypto.getRandomValues(bytes);
  bytes[0] &= BLINDING_TOP_BYTE_MASK;
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v.toString();
}

type Circuit = "claim" | "joinsplit";
const cachedAssets: Partial<Record<Circuit, Promise<{ wasm: Uint8Array; zkey: Uint8Array }>>> = {};

function loadAssets(name: Circuit): Promise<{ wasm: Uint8Array; zkey: Uint8Array }> {
  cachedAssets[name] ??= (async () => {
    const [wasmRes, zkeyRes] = await Promise.all([
      fetch(`/circuits/${name}.wasm`),
      fetch(`/circuits/${name}.zkey`),
    ]);
    if (!wasmRes.ok) throw new Error(`Failed to load ${name}.wasm (${wasmRes.status})`);
    if (!zkeyRes.ok) throw new Error(`Failed to load ${name}.zkey (${zkeyRes.status})`);
    const [wasm, zkey] = await Promise.all([wasmRes.arrayBuffer(), zkeyRes.arrayBuffer()]);
    return { wasm: new Uint8Array(wasm), zkey: new Uint8Array(zkey) };
  })().catch((e) => {
    delete cachedAssets[name]; // let a later attempt retry the download
    throw e;
  });
  return cachedAssets[name]!;
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
  const commitment = poseidon([secretDec, recipientDigest, amount, tokenId]);

  onStage?.("path");
  // Asset loading, the Merkle-path lookup, and the blinding sample +
  // Pedersen commitment (CPU-bound, independent of both) all run
  // concurrently rather than one after another.
  const [{ wasm, zkey }, pathRes, { blinding, amountCommitmentX, amountCommitmentY }] =
    await Promise.all([
      loadAssets("claim"),
      fetch(`${RESOLVER_URL}/path?commitment=${encodeURIComponent(commitment)}`),
      (async () => {
        const blinding = randomBlindingDec();
        // amountCommitmentX/Y are circuit *inputs*, constrained (===) against
        // the in-circuit Pedersen commitment of (amount, blinding); they must
        // be supplied matching that computation or witness generation fails.
        const { x: amountCommitmentX, y: amountCommitmentY } = pedersenCommit(
          amount,
          blinding
        );
        return { blinding, amountCommitmentX, amountCommitmentY };
      })(),
    ]);

  if (!pathRes.ok) {
    const err = (await pathRes.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      `Merkle path lookup failed: ${err.detail ?? pathRes.status}`
    );
  }
  const { leafIndex, root, pathElements, pathIndices } = (await pathRes.json()) as {
    leafIndex: number;
    root: string;
    pathElements: string[];
    pathIndices: number[];
  };
  if (!Number.isSafeInteger(leafIndex) || leafIndex < 0) {
    throw new Error("Merkle path lookup returned no leaf index (resolver out of date?)");
  }
  const nullifier = noteNullifier(secretDec, leafIndex);

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
      leafIndex: String(leafIndex),
      blinding,
      amountCommitmentX,
      amountCommitmentY,
    },
    wasm,
    zkey
  );

  // Public signal order, per circuits/src/claim.circom:
  // [root, nullifier, recipientDigest, amount, tokenId, amountCommitmentX, amountCommitmentY]
  if (publicSignals.length !== 7) {
    throw new Error(
      `unexpected public signal count: ${publicSignals.length} (expected 7; served claim.wasm/claim.zkey may be stale)`
    );
  }

  return {
    proof_a: g1(proof.pi_a),
    proof_b: g2(proof.pi_b),
    proof_c: g1(proof.pi_c),
    nullifier: fr(nullifier),
    root: fr(root),
    amountCommitmentX: fr(publicSignals[5]),
    amountCommitmentY: fr(publicSignals[6]),
  };
}

export interface SendProof {
  proof_a: string; // 192-char hex (G1)
  proof_b: string; // 384-char hex (G2)
  proof_c: string; // 192-char hex (G1)
}

/**
 * Prove a join-split (joinsplit.circom) in the browser. `input` and
 * `expectedPublic` come from buildSendWitness (joinsplit.ts). The public
 * signals are checked against what the contract will derive, so a stale
 * joinsplit.wasm/zkey fails here with a readable message instead of on-chain
 * as InvalidProof.
 */
export async function proveSend(
  input: Record<string, unknown>,
  expectedPublic: string[],
  onStage?: (stage: "loading" | "proving") => void
): Promise<SendProof> {
  onStage?.("loading");
  const { wasm, zkey } = await loadAssets("joinsplit");
  onStage?.("proving");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  if (
    publicSignals.length !== expectedPublic.length ||
    publicSignals.some((v: string, i: number) => v !== expectedPublic[i])
  ) {
    throw new Error(
      `join-split public signals do not match the transaction (served joinsplit.wasm/zkey may be stale)`
    );
  }
  return { proof_a: g1(proof.pi_a), proof_b: g2(proof.pi_b), proof_c: g1(proof.pi_c) };
}
