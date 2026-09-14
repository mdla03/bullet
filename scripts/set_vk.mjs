#!/usr/bin/env node
// Call set_vk (claim circuit) or set_pool_vk (shielded-pool join-split) on the
// deployed Zeekpay contract.
//
// Usage:
//   node scripts/set_vk.mjs                -> set_vk,      circuits/build/groth16_soroban.json
//   node scripts/set_vk.mjs pool           -> set_pool_vk, circuits/build/joinsplit_soroban.json
//   node scripts/set_vk.mjs --dry-run      -> simulate set_vk only, no submit
//   node scripts/set_vk.mjs pool --dry-run -> simulate set_pool_vk only, no submit
//   node scripts/set_vk.mjs --help         -> show this usage
//
// The two keys are separate on-chain and must not be crossed: the claim
// circuit has 7 public inputs as the contract derives them (8 IC entries),
// the join-split has 8 (9 IC entries). verifier::verify checks IC length
// against the public-input count, so a crossed key fails every proof with
// InvalidProof rather than misbehaving quietly, but it is still an outage.
//
// --dry-run builds the same transaction and runs it through the RPC's
// simulateTransaction (what `stellar contract invoke --send=no` also calls
// under the hood), printing the resource footprint and any error, then exits
// without signing or sending.
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

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: node scripts/set_vk.mjs [pool] [--dry-run]\n" +
    "  (none)      set_vk,      circuits/build/groth16_soroban.json, 8 IC entries\n" +
    "  pool        set_pool_vk, circuits/build/joinsplit_soroban.json, 9 IC entries\n" +
    "  --dry-run   simulate only, via RPC simulateTransaction; never signs or sends"
  );
  process.exit(0);
}
const dryRun = args.includes("--dry-run") || args.includes("-n");
const mode = args.includes("pool") ? "pool" : "claim";

if (!CONTRACT_ID) throw new Error("ZEEKPAY_CONTRACT_ID not set in .env");
if (!ADMIN_SECRET) throw new Error("ZEEKPAY_ADMIN_KEY not set in .env");

const vkFile = mode === "pool" ? "joinsplit_soroban.json" : "groth16_soroban.json";
const fnName = mode === "pool" ? "set_pool_vk" : "set_vk";
// Contract-side expectation (contracts/zeekpay/src/lib.rs: VkData.ic length
// is public inputs + 1, checked by verifier::verify). Claim is 7 public
// inputs -> 8 IC entries as of the 2026-09-14 Pedersen-commitment change
// (pipeline/circom-circuit/changes.md); join-split is unchanged at 8 -> 9.
// Used only as a fallback when the converted JSON predates convert-to-soroban.mjs
// writing nPublic.
const HARDCODED_EXPECTED_IC = mode === "pool" ? 9 : 8;

const vkPath = path.join(__dirname, `../circuits/build/${vkFile}`);
const vk = JSON.parse(fs.readFileSync(vkPath, "utf8"));

// Prefer the IC count derived from the converted JSON's own nPublic (written
// by convert-to-soroban.mjs) over the hardcoded value above, so this guard
// tracks the circuit shape automatically instead of needing a manual bump.
let expectedIc;
let expectedIcSource;
if (typeof vk.nPublic === "number") {
  expectedIc = vk.nPublic + 1;
  expectedIcSource = "nPublic";
} else {
  console.warn(
    `${vkFile} has no nPublic field (stale conversion); falling back to the hardcoded expected IC count ${HARDCODED_EXPECTED_IC}.`
  );
  expectedIc = HARDCODED_EXPECTED_IC;
  expectedIcSource = "hardcoded fallback";
}

// Cheap guard against pointing this at the wrong file, or a stale conversion:
// the IC count in the converted JSON must match what the contract expects.
if (vk.ic.length !== expectedIc) {
  console.error(
    `${vkFile} has ${vk.ic.length} IC entries, expected ${expectedIc} for ${fnName} (source: ${expectedIcSource}).`
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
console.log("IC count:", vk.ic.length, `(expected ${expectedIc}, source: ${expectedIcSource})`);
if (dryRun) console.log("Mode:     dry-run (simulate only, will not sign or send)");

const account = await rpc.getAccount(admin.publicKey());
const tx = new StellarSdk.TransactionBuilder(account, {
  fee: "2000000",
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(contract.call(fnName, vkMap))
  .setTimeout(60)
  .build();

if (dryRun) {
  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    console.log("simulation: ERROR");
    console.log("error:", sim.error);
    process.exit(1);
  }
  console.log("simulation: OK");
  const resources = sim.transactionData.build().resources();
  const footprint = resources.footprint();
  console.log(
    "resource footprint: readOnly=%d readWrite=%d",
    footprint.readOnly().length,
    footprint.readWrite().length
  );
  console.log("cpu instructions:", resources.instructions());
  console.log("disk read bytes: ", resources.diskReadBytes());
  console.log("write bytes:     ", resources.writeBytes());
  console.log("min resource fee:", sim.minResourceFee);
  if (StellarSdk.rpc.Api.isSimulationRestore(sim)) {
    console.log("restore required:", JSON.stringify(sim.restorePreamble, null, 2));
  }
  process.exit(0);
}

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
