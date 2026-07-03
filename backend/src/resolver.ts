import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import cors from "cors";
import type { ResolveResult } from "@zeekpay/shared";
import * as store from "./store.js";
import * as commitment from "./commitment.js";
import * as leaves from "./leaves.js";
import * as prove from "./prove.js";
import * as tree from "./tree.js";
import { requireAuth } from "./supabase.js";
import { verifyLinkWalletSig } from "./verify.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const app = express();
app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "https://bullet-frontend.vercel.app",
    credentials: true,
  })
);
app.use(express.json());

const CONTRACT_ADDRESS = process.env.ZEEKPAY_CONTRACT_ID ?? "";
const USDC_SAC = process.env.USDC_SAC_ID ?? "";
const PORT = parseInt(process.env.PORT ?? process.env.RESOLVER_PORT ?? "3001", 10);

// ── validation helpers ────────────────────────────────────────────────────────

const STELLAR_RE = /^G[A-Z2-7]{55}$/;
const ZEEKPAY_KEY_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^[0-9a-f]{128}$/;

function badRequest(res: Response, detail: string): void {
  res.status(400).json({ error: "invalid_input", detail });
}

// ── health + resolve (public) ─────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/resolve", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (!q || q.length > 256) {
    return void res.json({ found: false } satisfies ResolveResult);
  }
  const user = await store.findByLookup(q);
  if (!user || !user.wallet) {
    return void res.json({ found: false } satisfies ResolveResult);
  }
  res.json({
    found: true,
    stellarAddress: user.wallet.stellar_address,
    zeekPayPubKey: user.wallet.bullet_pubkey,
    contractAddress: CONTRACT_ADDRESS,
    usdcSac: USDC_SAC,
  } satisfies ResolveResult);
});

// ── /me: current session user + identities + wallet ───────────────────────────

app.get("/me", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as Request & { userId?: string }).userId!;
  const user = await store.getUser(userId);
  if (!user) return void res.status(404).json({ error: "profile_not_found" });
  res.json({
    authenticated: true,
    userId: user.id,
    identities: user.identities,
    wallet: user.wallet,
  });
});

// ── /wallet/link: attach Stellar wallet to session user ───────────────────────

app.post("/wallet/link", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as Request & { userId?: string }).userId!;
  const { stellarAddress, zeekPayPubKey, signature } = req.body as {
    stellarAddress?: string;
    zeekPayPubKey?: string;
    signature?: string;
  };
  if (!stellarAddress || !STELLAR_RE.test(stellarAddress))
    return void badRequest(res, "stellarAddress must be a valid Stellar public key (G…)");
  if (!zeekPayPubKey || !ZEEKPAY_KEY_RE.test(zeekPayPubKey))
    return void badRequest(res, "zeekPayPubKey must be a 64-char lowercase hex string");
  if (!signature || !SIG_RE.test(signature))
    return void badRequest(res, "signature must be a 128-char lowercase hex string");
  if (!verifyLinkWalletSig(userId, stellarAddress, signature))
    return void res.status(400).json({ error: "invalid_signature" });

  const result = await store.attachWallet(userId, {
    stellar_address: stellarAddress,
    bullet_pubkey: zeekPayPubKey,
    signature,
  });
  if ("conflict" in result) return void res.status(409).json({ error: "conflict", detail: result.detail });
  res.json({ ok: true, wallet: result.wallet });
});

// ── /commitment ───────────────────────────────────────────────────────────────

app.post("/commitment", (req: Request, res: Response) => {
  const { secret, recipientDigest, denom } = req.body as {
    secret?: string;
    recipientDigest?: string;
    denom?: string;
  };
  if (!secret || !recipientDigest || !denom) {
    return void badRequest(res, "secret, recipientDigest, denom required");
  }
  try {
    const c = commitment.computeCommitment(secret, recipientDigest, denom);
    const leafIndex = leaves.insert(c);
    tree.onLeafInserted(c, leafIndex);
    res.json({ commitment: c, leafIndex, root: tree.root() });
  } catch (e) {
    res.status(400).json({ error: "compute_failed", detail: String(e) });
  }
});

// ── /prove ────────────────────────────────────────────────────────────────────

app.post("/prove", async (req: Request, res: Response) => {
  if (!prove.isProveReady()) {
    return void res.status(503).json({
      error: "circuits_not_built",
      detail: "run pnpm build:circuits first",
    });
  }
  const adminKey = process.env.ZEEKPAY_ADMIN_KEY;
  const contractId = process.env.ZEEKPAY_CONTRACT_ID ?? "";
  if (!adminKey || !contractId) {
    return void res.status(503).json({ error: "admin_not_configured" });
  }
  const { secret, recipientDigest, denom } = req.body as {
    secret?: string;
    recipientDigest?: string;
    denom?: string;
  };
  if (!secret || !recipientDigest || !denom) {
    return void badRequest(res, "secret, recipientDigest, denom required");
  }
  try {
    const result = prove.generateProof(secret, recipientDigest, denom);
    const postRootHash = await postRootOnChain(adminKey, contractId, result.root);
    res.json({ ...result, postRootHash });
  } catch (e) {
    res.status(400).json({ error: "prove_failed", detail: String(e) });
  }
});

async function postRootOnChain(
  adminSecretKey: string,
  contractId: string,
  rootHex: string
): Promise<string> {
  const rpcUrl =
    process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const networkPassphrase =
    process.env.NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;

  const keypair = StellarSdk.Keypair.fromSecret(adminSecretKey);
  const rpc = new StellarSdk.rpc.Server(rpcUrl);
  const contract = new StellarSdk.Contract(contractId);

  const rootVal = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(rootHex, "hex"));
  const operation = contract.call("post_root", rootVal);

  const account = await rpc.getAccount(keypair.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);
  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw new Error(`sendTransaction: ${JSON.stringify(result.errorResult)}`);
  }
  const final = await rpc.pollTransaction(result.hash, { attempts: 20 });
  if (final.status !== "SUCCESS") throw new Error(`post_root tx ${final.status}`);
  return result.hash;
}

// ── start ─────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`[resolver] listening on http://localhost:${PORT}`);
  });
}

export { app };
