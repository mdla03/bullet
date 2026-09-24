// Deposit indexer: leaf placement, event paging and the root-post guard.
//
// The tree must hold each leaf at the contract's own leafIndex. Renumbering by
// array position, skipping ledgers the RPC never returned, or posting a root
// over a tree that disagrees with the contract all strand real notes.
//
// Run: node --import tsx/esm --experimental-test-module-mocks --test src/indexer.test.ts
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import * as real from "@stellar/stellar-sdk";

const TMP = path.join(os.tmpdir(), `zk_indexer_test_${Date.now()}.json`);
process.env.LEAVES_FILE_OVERRIDE = TMP;
fs.rmSync(TMP, { force: true });

const CONTRACT = "CCHHGCD33G5STIXEQGYK3IW3FOVJ7YTY4QKDWPMVHBRGIXDIV5OQQYSW";
const { xdr } = real;

// ── fake Postgres (merkle_store) ──────────────────────────────────────────────
let rows = new Map<number, string>();
let cursor: number | null = null;
const cursorWrites: number[] = [];
mock.module("./merkle_store.js", {
  namedExports: {
    loadLeaves: async () =>
      [...rows.entries()].map(([leafIndex, commitment]) => ({ leafIndex, commitment })),
    appendLeaf: async (i: number, c: string) => void rows.set(i, c),
    appendLeaves: async (entries: { leafIndex: number; commitment: string }[]) =>
      void entries.forEach((e) => rows.set(e.leafIndex, e.commitment)),
    getCursor: async () => cursor,
    setCursor: async (l: number) => {
      cursor = l;
      cursorWrites.push(l);
    },
    clearAll: async () => {
      rows = new Map();
      cursor = null;
    },
  },
});

mock.module("./chain_config.js", {
  namedExports: {
    RPC_URL: "http://fake-rpc",
    CONTRACT_ID: CONTRACT,
    ADMIN_KEY: real.Keypair.random().secret(),
  },
});

// ── fake Soroban RPC ──────────────────────────────────────────────────────────
type Page = { events: unknown[]; cursorLedger: number; latestLedger: number };
let pages: Page[] = [];
let chainIndex = 0;
let latest = 300;
const knownRoots = new Set<string>();
let posts = 0;

const cursorFor = (ledger: number) => `${(BigInt(ledger) << 32n) + 4095n}-4294967295`;
function page(p: Page) {
  return { events: p.events, cursor: cursorFor(p.cursorLedger), latestLedger: p.latestLedger, oldestLedger: 1 };
}
function depositEvent(ledger: number, index: number, fill: number) {
  return {
    ledger,
    topic: [xdr.ScVal.scvSymbol("deposit")],
    value: xdr.ScVal.scvVec([
      xdr.ScVal.scvBytes(Buffer.alloc(32, fill)),
      xdr.ScVal.scvU64(new xdr.Uint64(BigInt(index))),
    ]),
  };
}
const decOf = (fill: number) => BigInt("0x" + Buffer.alloc(32, fill).toString("hex")).toString();

class FakeServer {
  async getLatestLedger() {
    return { sequence: latest };
  }
  async getEvents(req: { startLedger?: number; cursor?: string }) {
    if (req.startLedger !== undefined) return page(pages[0]);
    const i = pages.findIndex((p) => cursorFor(p.cursorLedger) === req.cursor);
    return page(pages[i + 1]);
  }
  async getContractData(_c: string, key: InstanceType<typeof xdr.ScVal>) {
    // Only the contract instance (for `Index`) is read this way now;
    // is_known_root goes through simulateTransaction below, matching how the
    // real is_known_root view is called.
    if (key.switch().name === "scvLedgerKeyContractInstance") {
      const storage = [{ key: () => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Index")]), val: () => xdr.ScVal.scvU64(new xdr.Uint64(BigInt(chainIndex))) }];
      return { val: { contractData: () => ({ val: () => ({ instance: () => ({ storage: () => storage }) }) }) } };
    }
    throw new Error("not found");
  }
  async getAccount(pub: string) {
    return new real.Account(pub, "1");
  }
  async prepareTransaction(tx: unknown) {
    return tx;
  }
  async simulateTransaction(tx: { operations: { func: InstanceType<typeof xdr.HostFunction> }[] }) {
    // Only is_known_root is simulated by indexer.ts; read the root bytes arg
    // straight off the built operation, same as a real RPC would decode it.
    const invoke = tx.operations[0].func.invokeContract();
    const rootHex = Buffer.from(invoke.args()[0].bytes()).toString("hex");
    return { result: { retval: xdr.ScVal.scvBool(knownRoots.has(rootHex)) } };
  }
  async sendTransaction() {
    posts += 1;
    return { status: "PENDING", hash: "h" };
  }
  async pollTransaction() {
    return { status: "SUCCESS" };
  }
}

const { default: _d, ...sdkExports } = real as Record<string, unknown>;
mock.module("@stellar/stellar-sdk", {
  namedExports: { ...sdkExports, rpc: { ...real.rpc, Server: FakeServer } },
});

const leaves = await import("./leaves.js");
const tree = await import("./tree.js");
const indexer = await import("./indexer.js");

beforeEach(async () => {
  rows = new Map();
  cursor = null;
  cursorWrites.length = 0;
  pages = [];
  chainIndex = 0;
  latest = 300;
  knownRoots.clear();
  posts = 0;
  leaves._resetForTests();
  await indexer.hydrate();
});

describe("hydrate", () => {
  it("puts each stored leaf at its leaf_index, keeping gaps and ignoring row order", async () => {
    rows = new Map([
      [5, decOf(5)],
      [2, decOf(2)],
    ]);
    await indexer.hydrate();
    assert.equal(leaves.at(5), decOf(5));
    assert.equal(leaves.at(2), decOf(2));
    assert.deepEqual(leaves.missing(), [0, 1, 3, 4]);
    // Leaf 5 is a right child; its sibling at 4 is empty.
    assert.equal(tree.pathFor(5).pathIndices[0], 1);
    assert.equal(tree.pathFor(5).pathElements[0], "0");
  });
});

describe("pollOnce paging", () => {
  it("follows the RPC cursor across empty windows and never skips unscanned ledgers", async () => {
    cursor = 9; // start at ledger 10
    chainIndex = 1;
    pages = [
      { events: [], cursorLedger: 110, latestLedger: latest },
      { events: [], cursorLedger: 210, latestLedger: latest },
      { events: [depositEvent(250, 0, 7)], cursorLedger: 301, latestLedger: latest },
    ];
    const { inserted } = await indexer.pollOnce();
    assert.equal(inserted, 1);
    assert.equal(rows.get(0), decOf(7));
    assert.deepEqual(cursorWrites, [109, 209, 300]);
    assert.equal(posts, 1);
  });
});

describe("root post guard", () => {
  it("posts nothing when a leaf index is missing", async () => {
    cursor = 9;
    chainIndex = 3;
    pages = [{ events: [depositEvent(20, 0, 1), depositEvent(21, 2, 3)], cursorLedger: 301, latestLedger: latest }];
    await indexer.pollOnce();
    assert.equal(leaves.count(), 3);
    assert.equal(posts, 0);
  });

  it("posts nothing when the leaf count disagrees with the contract Index", async () => {
    cursor = 9;
    chainIndex = 3;
    pages = [{ events: [depositEvent(20, 0, 1), depositEvent(21, 1, 2)], cursorLedger: 301, latestLedger: latest }];
    await indexer.pollOnce();
    assert.equal(posts, 0);
  });

  it("posts once when the tree matches, and not again once the root is known", async () => {
    cursor = 9;
    chainIndex = 2;
    pages = [{ events: [depositEvent(20, 0, 1), depositEvent(21, 1, 2)], cursorLedger: 301, latestLedger: latest }];
    await indexer.pollOnce();
    assert.equal(posts, 1);
    knownRoots.add(BigInt(tree.root()).toString(16).padStart(64, "0"));
    cursor = 9;
    await indexer.hydrate();
    await indexer.pollOnce();
    assert.equal(posts, 1);
  });
});
