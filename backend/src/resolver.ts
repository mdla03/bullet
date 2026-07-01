import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import cors from "cors";
import type { RegisterRequest, ResolveResult } from "@zeekpay/shared";
import * as store from "./store.js";
import * as pending from "./pending.js";
import * as twitter from "./twitter.js";
import { verifyRegistrationSig } from "./verify.js";
import * as commitment from "./commitment.js";
import * as prove from "./prove.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const app = express();
app.use(cors());
app.use(express.json());

const CONTRACT_ADDRESS = process.env.ZEEKPAY_CONTRACT_ID ?? "";
const USDC_SAC = process.env.USDC_SAC_ID ?? "";
const PORT = parseInt(process.env.RESOLVER_PORT ?? "3001", 10);

// ── validation helpers ────────────────────────────────────────────────────────

const STELLAR_RE = /^G[A-Z2-7]{55}$/;
const ZEEKPAY_KEY_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^@]+@[^@]+\.[^@]+$/;
const SIG_RE = /^[0-9a-f]{128}$/;
const HANDLE_BODY_RE = /^[a-zA-Z0-9_]{1,15}$/;

function badRequest(res: Response, detail: string): void {
  res.status(400).json({ error: "invalid_input", detail });
}

// ── routes ────────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/resolve", (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (!q || q.length > 256) {
    return void res.json({ found: false } satisfies ResolveResult);
  }

  const key = store.normalizeKey(q);
  const entry = store.lookup(key);

  if (!entry) {
    return void res.json({ found: false } satisfies ResolveResult);
  }

  res.json({
    found: true,
    stellarAddress: entry.stellarAddress,
    zeekPayPubKey: entry.zeekPayPubKey,
    contractAddress: CONTRACT_ADDRESS,
    usdcSac: USDC_SAC,
  } satisfies ResolveResult);
});

app.post("/register", (req: Request, res: Response) => {
  const body = req.body as Partial<RegisterRequest>;

  if (!body.handle && !body.email) {
    return void badRequest(res, "at least one of handle or email is required");
  }
  if (!body.stellarAddress || !STELLAR_RE.test(body.stellarAddress)) {
    return void badRequest(res, "stellarAddress must be a valid Stellar public key (G…)");
  }
  if (!body.zeekPayPubKey || !ZEEKPAY_KEY_RE.test(body.zeekPayPubKey)) {
    return void badRequest(res, "zeekPayPubKey must be a 64-char lowercase hex string");
  }
  if (body.email && !EMAIL_RE.test(body.email)) {
    return void badRequest(res, "invalid email format");
  }

  const result = store.register({
    handle: body.handle,
    email: body.email,
    stellarAddress: body.stellarAddress,
    zeekPayPubKey: body.zeekPayPubKey,
    signature: body.signature ?? "",
  });

  if ("conflict" in result) {
    return void res.status(409).json({ error: "conflict", detail: result.detail });
  }

  res.json({ ok: true });
});

// ── POST /commitment ──────────────────────────────────────────────────────────

app.post("/commitment", (req: Request, res: Response) => {
  if (!commitment.isCircuitsReady()) {
    return void res.status(503).json({
      error: "circuits_not_built",
      detail: "run pnpm build:circuits first",
    });
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
    const c = commitment.computeCommitment(secret, recipientDigest, denom);
    res.json({ commitment: c });
  } catch (e) {
    res.status(400).json({ error: "compute_failed", detail: String(e) });
  }
});

// ── POST /prove ───────────────────────────────────────────────────────────────

app.post("/prove", (req: Request, res: Response) => {
  if (!prove.isProveReady()) {
    return void res.status(503).json({
      error: "circuits_not_built",
      detail: "run pnpm build:circuits first",
    });
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
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: "prove_failed", detail: String(e) });
  }
});

// ── POST /post-root ───────────────────────────────────────────────────────────

const ROOT_HEX_RE = /^[0-9a-f]{64}$/i;

app.post("/post-root", async (req: Request, res: Response) => {
  const adminKey = process.env.ZEEKPAY_ADMIN_KEY;
  const contractId = process.env.ZEEKPAY_CONTRACT_ID ?? "";
  if (!adminKey) {
    return void res.status(503).json({ error: "admin_key_not_configured" });
  }
  const { root } = req.body as { root?: string };
  if (!root || !ROOT_HEX_RE.test(root)) {
    return void badRequest(res, "root must be 64 lowercase hex chars");
  }
  try {
    const hash = await postRootOnChain(adminKey, contractId, root);
    res.json({ ok: true, hash });
  } catch (e) {
    res.status(500).json({ error: "post_root_failed", detail: String(e) });
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
  if (final.status !== "SUCCESS") {
    throw new Error(`post_root tx ${final.status}`);
  }
  return result.hash;
}

// ── POST /auth/twitter/start ──────────────────────────────────────────────────

app.post("/auth/twitter/start", async (req: Request, res: Response) => {
  if (!twitter.isConfigured()) {
    return void res.status(503).json({ error: "oauth_not_configured" });
  }

  const body = req.body as Partial<RegisterRequest>;

  if (!body.handle || !body.handle.startsWith("@")) {
    return void badRequest(res, "handle is required and must start with @");
  }
  if (!HANDLE_BODY_RE.test(body.handle.slice(1))) {
    return void badRequest(res, "handle must be 1-15 alphanumeric/underscore chars after @");
  }
  if (!body.stellarAddress || !STELLAR_RE.test(body.stellarAddress)) {
    return void badRequest(res, "stellarAddress must be a valid Stellar public key (G…)");
  }
  if (!body.zeekPayPubKey || !ZEEKPAY_KEY_RE.test(body.zeekPayPubKey)) {
    return void badRequest(res, "zeekPayPubKey must be a 64-char lowercase hex string");
  }
  if (!body.signature || !SIG_RE.test(body.signature)) {
    return void badRequest(res, "signature must be a 128-char lowercase hex string");
  }

  if (!verifyRegistrationSig(body.handle, body.stellarAddress, body.signature)) {
    return void res
      .status(400)
      .json({ error: "invalid_signature", detail: "Ed25519 verification failed" });
  }

  const { codeVerifier, codeChallenge } = twitter.generatePKCE();
  const state = crypto.randomUUID();

  pending.set(state, {
    handle: body.handle,
    stellarAddress: body.stellarAddress,
    zeekPayPubKey: body.zeekPayPubKey,
    signature: body.signature,
    codeVerifier,
  });

  res.json({ authUrl: twitter.buildAuthUrl(state, codeChallenge) });
});

// ── GET /auth/twitter/callback ────────────────────────────────────────────────

app.get("/auth/twitter/callback", async (req: Request, res: Response) => {
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
  const redirectErr = (e: string) =>
    res.redirect(`${frontendUrl}/register?error=${e}`);

  const q = req.query as Record<string, string | undefined>;
  const { code, state, error } = q;

  if (error) return void redirectErr("cancelled");
  if (!state || !code) return void redirectErr("invalid_request");

  const entry = pending.get(state);
  if (!entry) return void redirectErr("expired");

  try {
    const accessToken = await twitter.exchangeCode(code, entry.codeVerifier);
    const twitterUsername = await twitter.fetchUsername(accessToken);

    if (twitterUsername.toLowerCase() !== entry.handle.slice(1).toLowerCase()) {
      return void redirectErr("handle_mismatch");
    }

    const result = store.register({
      handle: entry.handle,
      stellarAddress: entry.stellarAddress,
      zeekPayPubKey: entry.zeekPayPubKey,
      signature: entry.signature,
    });

    pending.del(state);

    if ("conflict" in result) return void redirectErr("conflict");

    res.redirect(
      `${frontendUrl}/register?success=1&handle=${encodeURIComponent(entry.handle)}`
    );
  } catch {
    redirectErr("oauth_error");
  }
});

// ── start ─────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`[resolver] listening on http://localhost:${PORT}`);
  });
}

export { app };
