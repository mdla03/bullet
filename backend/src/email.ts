// SendGrid email delivery for invite claim links.
//
// Only fires when the invite handle is an email address. Best-effort:
// callers catch and warn; a send failure never blocks the invite commit.

import sgMail from "@sendgrid/mail";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY ?? "";
const FROM_EMAIL =
  process.env.SENDGRID_FROM_EMAIL ?? "bullet.noreply@gmail.com";
const FRONTEND_URL = (
  process.env.FRONTEND_URL ?? "https://bullet-frontend.vercel.app"
).replace(/\/$/, "");

function b64urlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Reconstruct the /c claim link from the stored payload fields.
 *  Must match encodeClaimLink() in frontend/src/lib/claim_link.ts exactly. */
export function buildClaimLink(payload: {
  secret: string;
  recipientDigest: string;
  amount: number;
}): string {
  return `${FRONTEND_URL}/c?p=${b64urlEncode({
    secret: payload.secret,
    recipientDigest: payload.recipientDigest,
    amount: payload.amount,
  })}`;
}

/** True when the handle looks like an email address rather than an X handle. */
export function isEmail(handle: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(handle);
}

/** Send the claim link to an email address via SendGrid.
 *  No-ops silently when SENDGRID_API_KEY is unset (local / staging). */
export async function sendClaimEmail(
  to: string,
  claimLink: string,
  amountUsdc: number,
  expiresInDays: number
): Promise<void> {
  if (!SENDGRID_API_KEY) {
    console.warn("[email] SENDGRID_API_KEY not set; skipping email delivery");
    return;
  }
  sgMail.setApiKey(SENDGRID_API_KEY);

  const text = [
    `Someone sent you $${amountUsdc} USDC privately using Bullet, a ZK payment rail on Stellar.`,
    ``,
    `Claim your payment here:`,
    `${claimLink}`,
    ``,
    `This link is your claim secret. Keep it private. Do not forward this email.`,
    `The funds expire in ${expiresInDays} days if unclaimed.`,
    ``,
    `Bullet never stores your claim secret. Only the holder of this link can claim the funds.`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html>
<body style="font-family:Inter,sans-serif;background:#F5F3EE;margin:0;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E5E0DE;border-radius:16px;padding:32px;">
    <p style="font-size:24px;font-weight:700;margin:0 0 8px;">$${amountUsdc} USDC waiting for you.</p>
    <p style="color:#6B6B6B;margin:0 0 24px;">Someone sent you a private payment on Bullet. Nothing on-chain identifies the sender or connects the deposit to your claim.</p>
    <a href="${claimLink}" style="display:inline-block;background:#0A0A0A;color:#F5F3EE;text-decoration:none;padding:12px 24px;border-radius:9999px;font-weight:600;">Claim $${amountUsdc} USDC</a>
    <p style="margin:24px 0 8px;font-size:13px;color:#6B6B6B;">Or copy this link:</p>
    <p style="font-family:monospace;font-size:12px;word-break:break-all;color:#6B6B6B;background:#F5F3EE;padding:12px;border-radius:8px;">${claimLink}</p>
    <p style="font-size:12px;color:#6B6B6B;margin-top:24px;">This link is your claim secret. Do not forward this email. Funds expire in ${expiresInDays} days if unclaimed.</p>
  </div>
</body>
</html>`;

  await sgMail.send({
    to,
    from: FROM_EMAIL,
    subject: `You have $${amountUsdc} USDC waiting on Bullet`,
    text,
    html,
  });
  console.log(`[email] claim email sent to ${to}`);
}
