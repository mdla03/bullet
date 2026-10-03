// Smoke test for the pool UI library: drives the exact functions the Pool
// screen calls (fundPool, fetchPath, withdrawNote) against testnet, with a
// local keypair standing in for the Freighter signer. Proves the shipped lib
// path works end to end, not just that it typechecks.
//
// The circuit assets are served from the freshly-built LOCAL public/circuits,
// not sendbullet.xyz, because the new join-split key is not deployed yet.
//
// Run:
//   E2E_SENDER_SECRET=$(stellar keys show zeekpay-bench) \
//   npx tsx --env-file=../.env scripts/pool_ui_smoke.mts

import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// snarkjs opens the wasm/zkey as files in Node, so point pool_tx at the freshly
// built local assets via the env override it reads. (In the browser these stay
// site-relative and are fetched.)
process.env.NEXT_PUBLIC_JOINSPLIT_WASM = fileURLToPath(
  new URL("../public/circuits/joinsplit.wasm", import.meta.url)
);
process.env.NEXT_PUBLIC_JOINSPLIT_ZKEY = fileURLToPath(
  new URL("../public/circuits/joinsplit.zkey", import.meta.url)
);

const { keypairFromEnv, localSigner } = await import("./_e2e_lib.mjs");
const { fundPool, withdrawNote } = await import("../src/lib/pool_ops");
const { fetchPath } = await import("../src/lib/pool_path");
const { noteCommitment } = await import("../src/lib/pool_note");

const SENDER = keypairFromEnv("E2E_SENDER_SECRET");
const sign = localSigner(SENDER);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ownerDigest = BigInt("0x" + randomBytes(31).toString("hex")).toString();
const AMOUNT = 33_300_000n; // 3.33 XLM
const TOKEN = 1;

console.log(`sender ${SENDER.publicKey()}`);
console.log(`shielding ${AMOUNT} stroops of token ${TOKEN}\n`);

const { note, txHash } = await fundPool(
  SENDER.publicKey(),
  AMOUNT,
  TOKEN,
  ownerDigest,
  sign,
  (s) => console.log(`  ${s}…`)
);
console.log(`fund tx ${txHash}`);

// syncPending's core: wait for the leaf to be indexed.
const commitment = noteCommitment(note);
process.stdout.write("waiting for the leaf to be indexed");
for (let i = 0; i < 30; i++) {
  if (await fetchPath(commitment)) break;
  process.stdout.write(".");
  await sleep(6000);
}
console.log(" indexed");

const wHash = await withdrawNote(
  SENDER.publicKey(),
  note,
  SENDER.publicKey(),
  sign,
  (s) => console.log(`  ${s}…`)
);
console.log(`\nwithdraw tx ${wHash}`);
console.log("pool UI library round trip OK");
process.exit(0);
