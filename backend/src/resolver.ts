import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import cors from "cors";
import type { ResolveResult } from "@zeekpay/shared";
import * as store from "./store.js";
import * as commitment from "./commitment.js";
import * as leaves from "./leaves.js";
import * as tree from "./tree.js";
import * as invite from "./invite.js";
import * as indexer from "./indexer.js";
import { requireAuth } from "./supabase.js";
import { verifyLinkWalletSig } from "./verify.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const app = express();
// CORS allowlist (M3). Reflecting any origin with credentials is unsafe and
// technically invalid; restrict to the configured frontend(s). Extra origins
// can be added via CORS_ALLOWED_ORIGINS (comma-separated).
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL ?? "http://localhost:3000",
  process.env.NEXT_PUBLIC_FRONTEND_URL,
  ...(process.env.CORS_ALLOWED_ORIGINS?.split(",") ?? []),
]
  .map((o) => o?.trim())
  .filter((o): o is string => !!o);
app.use(
  cors({
    origin(origin, cb) {
      // Non-browser clients (curl, server-to-server) send no Origin; allow.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("origin not allowed"));
    },
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
  // L1: keep the public health probe minimal. The deploy diagnostics (admin
  // pubkey, RPC URL, passphrase, node version) leak fingerprinting info, so
  // they are gated behind HEALTH_DEBUG=1 for local/staging troubleshooting.
  if (process.env.HEALTH_DEBUG !== "1") {
    return void res.json({ ok: true });
  }
  let adminPub: string | null = null;
  let adminError: string | null = null;
  try {
    const k = process.env.ZEEKPAY_ADMIN_KEY;
    if (!k) adminError = "not set";
    else {
      adminPub = StellarSdk.Keypair.fromSecret(k).publicKey();
    }
  } catch (e) {
    adminError = String(e).slice(0, 200);
  }
  res.json({
    ok: true,
    contractId: process.env.ZEEKPAY_CONTRACT_ID ?? null,
    adminPub,
    adminError,
    adminKeyLen: process.env.ZEEKPAY_ADMIN_KEY?.length ?? 0,
    rpcUrl: process.env.SOROBAN_RPC_URL ?? "default",
    networkPassphrase: process.env.NETWORK_PASSPHRASE ?? "default",
    nodeVersion: process.version,
  });
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
  // Best-effort: deliver any pending invites addressed to this user's handles.
  invite.deliverInvitesFor(userId, zeekPayPubKey).catch(() => {});
  res.json({ ok: true, wallet: result.wallet });
});

// ── /invite: send-to-unregistered flow ────────────────────────────────────────

app.post("/invite/prepare", requireAuth, async (_req: Request, res: Response) => {
  try {
    const custody = await invite.createCustodyAccount();
    res.json({
      custodyStellarAddress: custody.publicKey(),
      custodySecret: custody.secret(),
    });
  } catch (e) {
    res.status(500).json({ error: "custody_setup_failed", detail: String(e) });
  }
});

app.post("/invite/commit", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as Request & { userId?: string }).userId!;
  const { handle, denom, claimPayload, custodyStellarAddress, custodySecret, expiresInDays } =
    req.body as {
      handle?: string;
      denom?: 1 | 10 | 50 | 100;
      claimPayload?: unknown;
      custodyStellarAddress?: string;
      custodySecret?: string;
      expiresInDays?: 15 | 30;
    };
  if (!handle || !denom || !claimPayload || !custodyStellarAddress || !custodySecret) {
    return void badRequest(res, "handle, denom, claimPayload, custody fields required");
  }
  const days = expiresInDays === 15 ? 15 : 30;
  try {
    const { id } = await invite.recordInvite({
      senderUserId: userId,
      handle,
      denom,
      claimPayload,
      custody: { publicKey: custodyStellarAddress, secret: custodySecret },
      expiresInDays: days,
    });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: "invite_record_failed", detail: String(e) });
  }
});

app.get("/invites", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as Request & { userId?: string }).userId!;
  const items = await invite.listInvitesForSender(userId);
  res.json({ items });
});

// ── /notes/mark-claimed: caller-owned note only (writes are RLS-locked) ───────

app.post("/notes/mark-claimed", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as Request & { userId?: string }).userId!;
  const { noteId } = req.body as { noteId?: string };
  if (!noteId) return void badRequest(res, "noteId required");
  const ok = await store.markNoteClaimedIfOwned(userId, noteId);
  if (!ok) return void res.status(404).json({ error: "not_yours_or_missing" });
  res.json({ ok: true });
});

// ── /commitment ───────────────────────────────────────────────────────────────

// Pure commitment computation. SECURITY (C1): this endpoint MUST NOT insert
// into the Merkle tree or post a root. The tree is populated exclusively by the
// deposit indexer (indexer.ts) from confirmed on-chain deposits; a leaf that
// never had a matching deposit can never appear here. This route only echoes
// the Poseidon commitment so the sender's browser can build the deposit tx.
// NOTE: `secret` is sent to the backend here purely for the hash. Follow-up:
// move commitment computation fully client-side (frontend already ships the
// same Poseidon) so the backend never sees the claim secret.
app.post("/commitment", async (req: Request, res: Response) => {
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

// ── /path: return Merkle path for a known commitment (browser-side prover) ────

app.get("/path", (req: Request, res: Response) => {
  const c = String(req.query.commitment ?? "").trim();
  if (!c) return void badRequest(res, "commitment query param required");
  const leafIndex = leaves.indexOf(c);
  if (leafIndex === -1) {
    return void res
      .status(404)
      .json({ error: "unknown_commitment", detail: "commitment not in tree" });
  }
  try {
    const p = tree.pathFor(leafIndex);
    res.json({
      root: p.root,
      pathElements: p.pathElements,
      pathIndices: p.pathIndices,
    });
  } catch (e) {
    res.status(400).json({ error: "path_failed", detail: String(e) });
  }
});

// ── start ─────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`[resolver] listening on http://localhost:${PORT}`);
    // The deposit indexer is the sole writer of the Merkle tree (see C1 in
    // indexer.ts): it inserts leaves only for confirmed on-chain deposits.
    indexer.start();
  });
}

export { app };
