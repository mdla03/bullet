#!/usr/bin/env node
// Call set_vk (claim circuit) or set_pool_vk (shielded-pool join-split) on the
// deployed Zeekpay contract.
//
// Usage:
//   node scripts/set_vk.mjs          -> set_vk,      circuits/build/groth16_soroban.json
//   node scripts/set_vk.mjs pool     -> set_pool_vk, circuits/build/joinsplit_soroban.json
//
// The two keys are separate on-chain and must not be crossed: the claim
// circuit has 5 public inputs as the contract derives them, the join-split has
// 8. verifier::verify checks IC length against the public-input count, so a
// crossed key fails every proof with InvalidProof rather than misbehaving
// quietly, but it is still an outage.
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

const mode = process.argv[2] === "pool" ? "pool" : "claim";
const vkFile = mode === "pool" ? "joinsplit_soroban.json" : "groth16_soroban.json";
const fnName = mode === "pool" ? "set_pool_vk" : "set_vk";
const expectedIc = mode === "pool" ? 9 : 6;

const vkPath = path.join(__dirname, `../circuits/build/${vkFile}`);
const vk = JSON.parse(fs.readFileSync(vkPath, "utf8"));

// Cheap guard against pointing this at the wrong file. The claim key has 6 IC
// entries (5 public inputs + 1), the join-split has 9 (8 + 1).
if (vk.ic.length !== expectedIc) {
  console.error(
    `${vkFile} has ${vk.ic.length} IC entries, expected ${expectedIc} for ${fnName}.`
  );
  console.error("Refusing to set a key that does not match the circuit shape.");
  process.exit(1);
}

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
console.log("Function:", fnName);
console.log("VK file: ", vkFile);
console.log("IC count:", vk.ic.length);

const account = await rpc.getAccount(admin.publicKey());
const tx = new StellarSdk.TransactionBuilder(account, {
  fee: "2000000",
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(contract.call(fnName, vkMap))
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
console.log(`${fnName} SUCCESS. tx hash:`, result.hash);
