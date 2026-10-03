// Smoke test for the pool UI's private-send path: fund a note, transfer part of
// it to a recipient digest with the amount hidden, then withdraw the recipient's
// resulting note. Exercises transferNote (the slice-2 op) end to end on testnet.
//
// Run:
//   E2E_SENDER_SECRET=$(stellar keys show zeekpay-bench) E2E_RECIP_1_SECRET=… \
//   npx tsx --env-file=../.env scripts/pool_ui_send_smoke.mts

import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

process.env.NEXT_PUBLIC_JOINSPLIT_WASM = fileURLToPath(
  new URL("../public/circuits/joinsplit.wasm", import.meta.url)
);
process.env.NEXT_PUBLIC_JOINSPLIT_ZKEY = fileURLToPath(
  new URL("../public/circuits/joinsplit.zkey", import.meta.url)
);

const { keypairFromEnv, localSigner } = await import("./_e2e_lib.mjs");
const { fundPool, transferNote, withdrawNote } = await import("../src/lib/pool_ops");
const { fetchPath } = await import("../src/lib/pool_path");
const { noteCommitment } = await import("../src/lib/pool_note");

const SENDER = keypairFromEnv("E2E_SENDER_SECRET");
const RECIP = keypairFromEnv("E2E_RECIP_1_SECRET");
const sign = localSigner(SENDER);
const recipSign = localSigner(RECIP);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomFr = () => BigInt("0x" + randomBytes(31).toString("hex")).toString();

const TOKEN = 1;
const FUND = 50_000_000n; // 5 XLM
const SEND = 20_000_000n; // 2 XLM, hidden

async function waitIndexed(commitment: string) {
  for (let i = 0; i < 40; i++) {
    if (await fetchPath(commitment)) return;
    await sleep(6000);
  }
  throw new Error("leaf never indexed");
}

console.log(`fund ${FUND} stroops, then send ${SEND} hidden\n`);
const { note, txHash } = await fundPool(SENDER.publicKey(), FUND, TOKEN, randomFr(), sign, (s) =>
  console.log(`  ${s}…`)
);
console.log(`fund tx ${txHash}`);
await waitIndexed(noteCommitment(note));
console.log("funded note indexed");

const recipientDigest = randomFr();
const { txHash: transferTx, recipientNote, changeNote } = await transferNote(
  SENDER.publicKey(),
  note,
  recipientDigest,
  SEND,
  randomFr(),
  sign,
  (s) => console.log(`  ${s}…`)
);
console.log(`transfer tx ${transferTx} (amount hidden)`);
console.log(`  recipient note ${SEND} stroops, change ${changeNote ? (note.value - SEND).toString() : "0"} stroops`);

await waitIndexed(noteCommitment(recipientNote));
console.log("recipient note indexed");

// The recipient withdraws their own note: they sign, to their own account.
const wTx = await withdrawNote(RECIP.publicKey(), recipientNote, RECIP.publicKey(), recipSign, (s) =>
  console.log(`  ${s}…`)
);
console.log(`\nwithdraw tx ${wTx} -> ${RECIP.publicKey()}`);
console.log("pool private-send round trip OK");
process.exit(0);
