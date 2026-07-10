#!/usr/bin/env node
// Call set_vk on the deployed Zeekpay contract.
// Reads circuits/build/groth16_soroban.json for the VK hex data.
// Usage: node scripts/set_vk.mjs
import * as StellarSdk from "@stellar/stellar-sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env manually (no dotenv dependency needed)
const envPath = path.join(__dirname, "../.env");
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
});

const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.ZEEKPAY_CONTRACT_ID;
const ADMIN_SECRET = process.env.ZEEKPAY_ADMIN_KEY;
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET;

if (!CONTRACT_ID) throw new Error("ZEEKPAY_CONTRACT_ID not set in .env");
if (!ADMIN_SECRET) throw new Error("ZEEKPAY_ADMIN_KEY not set in .env");

const vkPath = path.join(__dirname, "../circuits/build/groth16_soroban.json");
const vk = JSON.parse(fs.readFileSync(vkPath, "utf8"));

const { xdr } = StellarSdk;

function hexBytes(hex) {
  return xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
}

function scSymbol(s) {
  return xdr.ScVal.scvSymbol(s);
}

// Soroban encodes #[contracttype] struct fields in alphabetical order.
const icVec = xdr.ScVal.scvVec(vk.ic.map(hexBytes));

const vkMap = xdr.ScVal.scvMap([
  new xdr.ScMapEntry({ key: scSymbol("alpha1"), val: hexBytes(vk.alpha1) }),
  new xdr.ScMapEntry({ key: scSymbol("beta2"),  val: hexBytes(vk.beta2)  }),
  new xdr.ScMapEntry({ key: scSymbol("delta2"), val: hexBytes(vk.delta2) }),
  new xdr.ScMapEntry({ key: scSymbol("gamma2"), val: hexBytes(vk.gamma2) }),
  new xdr.ScMapEntry({ key: scSymbol("ic"),     val: icVec               }),
]);

const rpc = new StellarSdk.rpc.Server(RPC_URL);
const admin = StellarSdk.Keypair.fromSecret(ADMIN_SECRET);
const contract = new StellarSdk.Contract(CONTRACT_ID);

console.log("Contract:", CONTRACT_ID);
console.log("Admin:   ", admin.publicKey());
console.log("IC count:", vk.ic.length);

const account = await rpc.getAccount(admin.publicKey());
const tx = new StellarSdk.TransactionBuilder(account, {
  fee: "2000000",
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(contract.call("set_vk", vkMap))
  .setTimeout(60)
  .build();

const prepared = await rpc.prepareTransaction(tx);
prepared.sign(admin);
const result = await rpc.sendTransaction(prepared);
console.log("send status:", result.status);
if (result.status === "ERROR") {
  console.error("error:", JSON.stringify(result.errorResult, null, 2));
  process.exit(1);
}
const final = await rpc.pollTransaction(result.hash, { attempts: 30 });
console.log("final status:", final.status);
if (final.status !== "SUCCESS") {
  console.error("tx failed:", final.status);
  process.exit(1);
}
console.log("set_vk SUCCESS. tx hash:", result.hash);
