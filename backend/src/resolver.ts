import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import cors from "cors";
import type { ResolveResult } from "@zeekpay/shared";
import * as store from "./store.js";
import * as pending from "./pending.js";
import * as twitter from "./twitter.js";
import * as google from "./google.js";
import { verifyLinkWalletSig } from "./verify.js";
import * as commitment from "./commitment.js";
import * as leaves from "./leaves.js";
import * as prove from "./prove.js";
import * as tree from "./tree.js";
import * as session from "./session.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const app = express();
app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());
app.use(session.sessionMiddleware);

const CONTRACT_ADDRESS = process.env.ZEEKPAY_CONTRACT_ID ?? "";
const USDC_SAC = process.env.USDC_SAC_ID ?? "";
const PORT = parseInt(process.env.RESOLVER_PORT ?? "3001", 10);
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

// ── validation helpers ────────────────────────────────────────────────────────

const STELLAR_RE = /^G[A-Z2-7]{55}$/;
const ZEEKPAY_KEY_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^[0-9a-f]{128}$/;
const TWITTER_HANDLE_RE = /^@[a-zA-Z0-9_]{1,15}$/;

function badRequest(res: Response, detail: string): void {
  res.status(400).json({ error: "invalid_input", detail });
}

// ── health + resolve (public) ─────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/resolve", (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (!q || q.length > 256) {
    return void res.json({ found: false } satisfies ResolveResult);
  }
  const user = store.findByLookup(q);
  if (!user || !user.wallet) {
    return void res.json({ found: false } satisfies ResolveResult);
  }
  res.json({
    found: true,
    stellarAddress: user.wallet.stellarAddress,
    zeekPayPubKey: user.wallet.zeekPayPubKey,
    contractAddress: CONTRACT_ADDRESS,
    usdcSac: USDC_SAC,
  } satisfies ResolveResult);
});

// ── /me: current session user + identities + wallet status ────────────────────

app.get("/me", (req: Request, res: Response) => {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) return void res.json({ authenticated: false });
  const user = store.getUser(userId);
  if (!user) return void res.json({ authenticated: false });
  res.json({
    authenticated: true,
    userId: user.id,
    identities: user.identities,
    wallet: user.wallet,
  });
});

app.post("/auth/logout", (_req: Request, res: Response) => {
  session.destroySession(res);
  res.json({ ok: true });
});

// ── /wallet/link: attach Stellar wallet to session user ───────────────────────

app.post("/wallet/link", session.requireSession, (req: Request, res: Response) => {
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

  const result = store.attachWallet(userId, { stellarAddress, zeekPayPubKey, signature });
  if ("conflict" in result) return void res.status(409).json({ error: "conflict", detail: result.detail });
  res.json({ ok: true, user: result.user });
});

// ── OAuth (shared plumbing for both providers) ────────────────────────────────

function startOAuth(
  provider: "twitter" | "google",
  handle: string | undefined,
  req: Request,
  res: Response,
): void {
  const p = provider === "twitter" ? twitter : google;
  if (!p.isConfigured()) {
    return void res.status(503).json({ error: "oauth_not_configured" });
  }
  const { codeVerifier, codeChallenge } = p.generatePKCE();
  const state = crypto.randomUUID();
  pending.set(state, {
    provider,
    handle,
    codeVerifier,
    existingUserId: (req as Request & { userId?: string }).userId,
  });
  res.json({ authUrl: p.buildAuthUrl(state, codeChallenge) });
}

function redirectPost(res: Response, path: string, params: Record<string, string>): void {
  const qs = new URLSearchParams(params).toString();
  res.redirect(`${FRONTEND_URL}${path}?${qs}`);
}

async function completeOAuth(
  provider: "twitter" | "google",
  req: Request,
  res: Response,
): Promise<void> {
  const q = req.query as Record<string, string | undefined>;
  const { code, state, error } = q;
  if (error) return void redirectPost(res, "/login", { error: "cancelled" });
  if (!state || !code) return void redirectPost(res, "/login", { error: "invalid_request" });

  const entry = pending.get(state);
  if (!entry || entry.provider !== provider)
    return void redirectPost(res, "/login", { error: "expired" });

  try {
    let ident: Omit<store.Identity, "linkedAt">;
    if (provider === "twitter") {
      const token = await twitter.exchangeCode(code, entry.codeVerifier);
      const profile = await twitter.fetchProfile(token);
      const handle = "@" + profile.username;
      if (entry.handle && entry.handle.toLowerCase() !== handle.toLowerCase()) {
        return void redirectPost(res, "/login", { error: "handle_mismatch" });
      }
      ident = { provider: "twitter", subject: profile.subject, handle };
    } else {
      const token = await google.exchangeCode(code, entry.codeVerifier);
      const profile = await google.fetchProfile(token);
      if (!profile.emailVerified)
        return void redirectPost(res, "/login", { error: "email_unverified" });
      ident = {
        provider: "google",
        subject: profile.subject,
        handle: profile.email,
        email: profile.email,
      };
    }

    pending.del(state);

    // Decide: attach to existing session user, or find-or-create by (provider, subject).
    let userId: string;
    if (entry.existingUserId) {
      const r = store.addIdentity(entry.existingUserId, ident);
      if ("conflict" in r) return void redirectPost(res, "/link", { error: r.detail });
      userId = entry.existingUserId;
    } else {
      const existing = store.findByProviderSubject(ident.provider, ident.subject);
      if (existing) {
        userId = existing.id;
      } else {
        const r = store.createUserWithIdentity(ident);
        if ("conflict" in r) return void redirectPost(res, "/login", { error: r.detail });
        userId = r.user.id;
      }
    }

    session.createSession(res, userId);
    redirectPost(res, entry.existingUserId ? "/link" : "/login", { success: "1" });
  } catch {
    redirectPost(res, entry.existingUserId ? "/link" : "/login", { error: "oauth_error" });
  }
}

// ── /auth/twitter ─────────────────────────────────────────────────────────────

app.post("/auth/twitter/start", (req: Request, res: Response) => {
  const { handle } = req.body as { handle?: string };
  if (handle && !TWITTER_HANDLE_RE.test(handle))
    return void badRequest(res, "handle must match @[a-zA-Z0-9_]{1,15}");
  startOAuth("twitter", handle, req, res);
});

app.get("/auth/twitter/callback", (req: Request, res: Response) =>
  completeOAuth("twitter", req, res)
);

// ── /auth/google ──────────────────────────────────────────────────────────────

app.post("/auth/google/start", (req: Request, res: Response) => {
  startOAuth("google", undefined, req, res);
});

app.get("/auth/google/callback", (req: Request, res: Response) =>
  completeOAuth("google", req, res)
);

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
