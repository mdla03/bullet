// Handle verification report.
//
// Answers one question for a reviewer: are these accounts real, or did the
// builder make them? It lists every linked handle with the platform's own
// immutable id and a public profile URL, so the claim can be checked against
// the platform rather than taken on trust.
//
// The argument the report supports is structural. Only two code paths write a
// handles row, and neither accepts a handle from the client:
//
//   - the on_auth_identity_created trigger (backend/sql/handles_schema.sql),
//     which fires on an auth.identities insert, i.e. a completed Supabase
//     OAuth login;
//   - link_telegram_handle, called by telegram.ts only after
//     verifyTelegramLogin checks Telegram's HMAC and the auth_date window.
//
// An email handle proves only that someone typed an address, so the report
// counts those separately rather than folding them in. Accounts created with
// the service role (seed and load-test accounts) have an email identity and
// nothing else, so they appear as email-only here: that separation only holds
// while seeded accounts are never given an OAuth or Telegram handle.
//
// Run: pnpm --filter @zeekpay/backend report
// Output is markdown on stdout. Redirect it where you want it.

import { pathToFileURL } from "node:url";
import {
  enabledHandleTypes,
  handleTypeForIdentityProvider,
  type HandleType,
} from "@zeekpay/shared";
import { serviceClient } from "./supabase.js";

export interface HandleRow {
  user_id: string;
  provider: string;
  subject: string | null;
  handle: string;
  linked_at: string | null;
}

/** How a handle of this type came to exist. */
function proofOf(type: HandleType): string {
  switch (type.proof.type) {
    case "supabase-oauth":
      return `${type.label} OAuth`;
    case "telegram-widget":
      return "Telegram login";
    case "email-otp":
      return "email only";
  }
}

/** Platform-verified means a third party confirmed control. An email address
 *  is self-asserted, so it does not count. */
function isPlatformVerified(type: HandleType): boolean {
  return type.proof.type !== "email-otp";
}

function md(value: string | null | undefined): string {
  return value && value.length > 0 ? value : "—";
}

export interface Report {
  markdown: string;
  accounts: number;
  verifiedAccounts: number;
  unknownProvider: number;
}

/** Builds the report from handle rows. Pure, so the counting and the
 *  verified/self-asserted split are testable without a database. */
export function buildReport(rows: HandleRow[], now = new Date()): Report {
  // Bucket by handle type via the registry rather than by matching provider
  // strings here, so X's three auth.identities spellings land together and a
  // newly enabled type needs no edit in this file.
  const byType = new Map<string, HandleRow[]>();
  const accounts = new Map<string, { verified: boolean }>();
  let unknownProvider = 0;

  for (const row of rows) {
    const type = handleTypeForIdentityProvider(row.provider);
    if (!type) {
      unknownProvider += 1;
      continue;
    }
    const list = byType.get(type.id) ?? [];
    list.push(row);
    byType.set(type.id, list);

    const account = accounts.get(row.user_id) ?? { verified: false };
    account.verified ||= isPlatformVerified(type);
    accounts.set(row.user_id, account);
  }

  const verifiedAccounts = [...accounts.values()].filter((a) => a.verified).length;

  const out: string[] = [];
  out.push("# Handle verification report");
  out.push("");
  out.push(`Generated ${now.toISOString()}.`);
  out.push("");
  out.push(
    "Every row below exists because the named platform confirmed control of " +
      "that account. Bullet never writes a handle from a value the sender or " +
      "the recipient typed. The two write paths are the " +
      "`on_auth_identity_created` trigger (`backend/sql/handles_schema.sql`), " +
      "which fires only on a completed Supabase OAuth login, and " +
      "`link_telegram_handle`, called by `backend/src/telegram.ts` only after " +
      "`verifyTelegramLogin` checks Telegram's HMAC signature and its " +
      "ten-minute `auth_date` window. Both are in the public repository."
  );
  out.push("");
  out.push(
    "**Platform id** is the platform's own immutable identifier, not one " +
      "Bullet assigned. It can be resolved independently at the profile link."
  );
  out.push("");

  out.push("## Summary");
  out.push("");
  out.push(`- Accounts with at least one platform-verified handle: **${verifiedAccounts}**`);
  out.push(`- Accounts with an email handle only (self-asserted): **${accounts.size - verifiedAccounts}**`);
  out.push("");
  out.push("| Platform | Verified by | Handles linked |");
  out.push("| --- | --- | --- |");
  for (const type of enabledHandleTypes()) {
    out.push(`| ${type.label} | ${proofOf(type)} | ${(byType.get(type.id) ?? []).length} |`);
  }
  out.push("");

  for (const type of enabledHandleTypes()) {
    const list = byType.get(type.id) ?? [];
    if (list.length === 0 || !isPlatformVerified(type)) continue;
    out.push(`## ${type.label} (${proofOf(type)})`);
    out.push("");
    out.push("| Handle | Platform id | Profile | Linked |");
    out.push("| --- | --- | --- | --- |");
    for (const row of list) {
      const url = type.profileUrl?.(row.handle) ?? null;
      out.push(
        `| ${md(type.format(row.handle))} | \`${md(row.subject)}\` | ` +
          `${url ? `[${url.replace(/^https:\/\//, "")}](${url})` : "—"} | ` +
          `${md(row.linked_at?.slice(0, 10))} |`
      );
    }
    out.push("");
  }

  if (unknownProvider > 0) {
    out.push(
      `_${unknownProvider} handle row(s) from a provider the registry no ` +
        "longer recognises, from a type that has since been disabled._"
    );
    out.push("");
  }

  return {
    markdown: out.join("\n"),
    accounts: accounts.size,
    verifiedAccounts,
    unknownProvider,
  };
}

async function main(): Promise<void> {
  const { data, error } = await serviceClient
    .from("handles")
    .select("user_id, provider, subject, handle, linked_at")
    .order("linked_at", { ascending: true })
    .limit(10000);
  if (error) throw new Error(`handles read failed: ${error.message}`);
  const rows = (data ?? []) as HandleRow[];

  const report = buildReport(rows);
  console.log(report.markdown);

  // On stderr so it never lands in the redirected report.
  console.error(
    `\n[verify_report] ${rows.length} handle rows across ${report.accounts} accounts.\n` +
      "[verify_report] This names other people's accounts. Get their consent\n" +
      "[verify_report] before publishing it anywhere public.\n"
  );
}

// Only when run as a script. Importing buildReport (the tests, or any future
// caller) must not open a database connection as a side effect of the import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`[verify_report] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
