import express, { type Request, type Response } from "express";
import type { RegisterRequest, ResolveResult } from "@zeekpay/shared";
import * as store from "./store.js";

const app = express();
app.use(express.json());

const CONTRACT_ADDRESS = process.env.ZEEKPAY_CONTRACT_ID ?? "";
const USDC_SAC = process.env.USDC_SAC_ID ?? "";
const PORT = parseInt(process.env.RESOLVER_PORT ?? "3001", 10);

// ── validation helpers ────────────────────────────────────────────────────────

const STELLAR_RE = /^G[A-Z2-7]{55}$/;
const ZEEKPAY_KEY_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^@]+@[^@]+\.[^@]+$/;

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
  const body = req.body as Partial<RegisterRequest & { signature: string }>;

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

// ── start ─────────────────────────────────────────────────────────────────────
// Only auto-start when run directly (not imported for testing).

import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`[resolver] listening on http://localhost:${PORT}`);
  });
}

export { app };
