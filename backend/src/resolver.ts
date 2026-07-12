import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import type { ResolveResult } from "@zeekpay/shared";
import * as store from "./store.js";
import * as leaves from "./leaves.js";
import * as tree from "./tree.js";
import * as invite from "./invite.js";
import * as email from "./email.js";
import * as indexer from "./indexer.js";
import { requireAuth } from "./supabase.js";
import { verifyLinkWalletSig } from "./verify.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const app = express();
// CORS allowlist (M3). Reflecting any origin with credentials is unsafe and
// technically invalid; restrict to the configured frontend(s). Extra origins
// can be added via CORS_ALLOWED_ORIGINS (comma-separated).
// Known first-party frontends are always allowed so a missing/misconfigured
// env var can't CORS-block the real site; env vars add to (not replace) these.
const DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "https://sendbullet.xyz",
  "https://bullet-frontend.vercel.app",
];
const ALLOWED_ORIGINS = Array.from(
  new Set(
    [
      ...DEFAULT_ORIGINS,
      process.env.FRONTEND_URL,
      process.env.NEXT_PUBLIC_FRONTEND_URL,
      ...(process.env.CORS_ALLOWED_ORIGINS?.split(",") ?? []),
    ]
      .map((o) => o?.trim())
      .filter((o): o is string => !!o)
  )
);
app.use(
  cors({
    origin(origin, cb) {
      // Non-browser clients (curl, server-to-server) send no Origin; allow.
      // Disallowed browser origins get no ACAO header (the browser blocks the
      // response). Return false rather than throwing, which would 500.
      cb(null, !origin || ALLOWED_ORIGINS.includes(origin));
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

// ── rate limiter (M1) ─────────────────────────────────────────────────────────
// In-memory sliding window keyed by userId (falls back to IP). Guards funder-
// draining routes like /invite/prepare, which funds a custody account with real
// XLM per call. For a single-process demo this is enough; a multi-instance
// deploy needs a shared store (Redis).
const rateBuckets = new Map<string, number[]>();
export function rateLimit(maxPerWindow: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key =
      (req as Request & { userId?: string }).userId ?? req.ip ?? "anon";
    const now = Date.now();
    const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= maxPerWindow) {
      res
        .status(429)
        .json({ error: "rate_limited", detail: "Too many requests. Slow down and retry shortly." });
      return;
    }
    hits.push(now);
    rateBuckets.set(key, hits);
    next();
  };
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

app.post("/invite/prepare", requireAuth, rateLimit(5, 10 * 60 * 1000), async (_req: Request, res: Response) => {
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
  const { handle, amount, claimPayload, custodyStellarAddress, custodySecret, expiresInDays } =
    req.body as {
      handle?: string;
      amount?: number;
      claimPayload?: unknown;
      custodyStellarAddress?: string;
      custodySecret?: string;
      expiresInDays?: 15 | 30;
    };
  if (!handle || !amount || !claimPayload || !custodyStellarAddress || !custodySecret) {
    return void badRequest(res, "handle, amount, claimPayload, custody fields required");
  }
  const days = expiresInDays === 15 ? 15 : 30;
  try {
    const { id } = await invite.recordInvite({
      senderUserId: userId,
      handle,
      amount,
      claimPayload,
      custody: { publicKey: custodyStellarAddress, secret: custodySecret },
      expiresInDays: days,
    });
    // Best-effort email delivery when the handle is an email address.
    if (email.isEmail(handle)) {
      const cp = claimPayload as { secret: string; recipientDigest: string; amount: number };
      const link = email.buildClaimLink(cp);
      email
        .sendClaimEmail(handle, link, Math.round(amount / 10_000_000), days)
        .catch((e: unknown) => {
          console.warn("[email] claim email failed:", String(e).slice(0, 200));
        });
    }
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

// ── /notes: deliver an encrypted inbox note (M4) ──────────────────────────────
// notes INSERT is RLS-locked to the service role, so browsers deliver through
// here instead of inserting directly (which let anyone spam any inbox). We
// validate the ciphertext shape, require the recipient to be a registered
// Bullet key, and rate-limit. No auth: an anonymous sender may still deliver to
// a registered recipient's inbox, but only to real keys and not in bulk.
const HEX_RE = /^[0-9a-f]+$/;
const NONCE_RE = /^[0-9a-f]{48}$/; // 24-byte nacl.box nonce

app.post("/notes", rateLimit(60, 10 * 60 * 1000), async (req: Request, res: Response) => {
  const { recipientPubkey, ephemeralPubkey, nonce, ciphertext } = req.body as {
    recipientPubkey?: string;
    ephemeralPubkey?: string;
    nonce?: string;
    ciphertext?: string;
  };
  if (!recipientPubkey || !ZEEKPAY_KEY_RE.test(recipientPubkey))
    return void badRequest(res, "recipientPubkey must be 64-char lowercase hex");
  if (!ephemeralPubkey || !ZEEKPAY_KEY_RE.test(ephemeralPubkey))
    return void badRequest(res, "ephemeralPubkey must be 64-char lowercase hex");
  if (!nonce || !NONCE_RE.test(nonce))
    return void badRequest(res, "nonce must be 48-char lowercase hex");
  if (!ciphertext || !HEX_RE.test(ciphertext) || ciphertext.length > 8192)
    return void badRequest(res, "ciphertext must be lowercase hex (<= 8192 chars)");

  if (!(await store.pubkeyIsRegistered(recipientPubkey)))
    return void res.status(404).json({ error: "recipient_not_registered" });

  const ok = await store.insertNote({
    recipient_pubkey: recipientPubkey,
    ephemeral_pubkey: ephemeralPubkey,
    nonce,
    ciphertext,
  });
  if (!ok) return void res.status(500).json({ error: "note_insert_failed" });
  res.json({ ok: true });
});

// ── /commitment ───────────────────────────────────────────────────────────────

// NOTE: the old POST /commitment endpoint was removed. The commitment is now
// computed entirely in the browser (frontend/src/lib/commitment.ts) so the
// claim secret never reaches the backend. The Merkle tree is populated only by
// the deposit indexer from confirmed on-chain deposits (see indexer.ts, C1).

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

// ── /admin/reindex: force the indexer to rescan from a ledger (recovery) ──────
// Re-inserts any on-chain deposits missing from the tree (e.g. after an
// ephemeral-host wipe before Postgres persistence). Guarded by a shared secret.
const INDEXER_ADMIN_TOKEN = process.env.INDEXER_ADMIN_TOKEN ?? "";
app.post("/admin/reindex", async (req: Request, res: Response) => {
  if (!INDEXER_ADMIN_TOKEN || req.header("x-admin-token") !== INDEXER_ADMIN_TOKEN)
    return void res.status(401).json({ error: "unauthorized" });
  const { fromLedger } = req.body as { fromLedger?: number };
  if (typeof fromLedger !== "number" || fromLedger < 0)
    return void badRequest(res, "fromLedger (non-negative number) required");
  try {
    const result = await indexer.reprocessFrom(fromLedger);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: "reindex_failed", detail: String(e).slice(0, 400) });
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
