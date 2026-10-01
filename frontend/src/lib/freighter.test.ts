import assert from "node:assert/strict";
import test from "node:test";

// A stand-in for the extension's content script. @stellar/freighter-api talks
// to it over window.postMessage, so faking the window exercises the real API
// package rather than a stub of it. The window must exist before the package
// is first imported, which is why freighter.ts is imported lazily below.
type Listener = (ev: { source: unknown; data: Record<string, unknown> }) => void;
const listeners = new Set<Listener>();
const calls: string[] = [];
const ext = { installed: true, allowed: true };

const fakeWindow: Record<string, unknown> = {
  location: { origin: "http://localhost" },
  addEventListener: (_t: string, fn: Listener) => listeners.add(fn),
  removeEventListener: (_t: string, fn: Listener) => listeners.delete(fn),
  postMessage: (msg: Record<string, unknown>) => {
    calls.push(String(msg.type));
    const reply: Record<string, unknown> = {};
    switch (msg.type) {
      case "REQUEST_CONNECTION_STATUS":
        reply.isConnected = ext.installed;
        break;
      case "REQUEST_ALLOWED_STATUS":
        reply.isAllowed = ext.allowed;
        break;
      case "REQUEST_ACCESS":
        ext.allowed = true;
        reply.publicKey = "GADDR";
        break;
      case "SUBMIT_TRANSACTION":
        reply.signedTransaction = "SIGNED";
        break;
      case "SUBMIT_BLOB":
        reply.signedBlob = "SIG";
        break;
    }
    setTimeout(() => {
      for (const fn of listeners)
        fn({
          source: fakeWindow,
          data: { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: msg.messageId, ...reply },
        });
    }, 0);
  },
};
(globalThis as { window?: unknown }).window = fakeWindow;

function reset(patch: Partial<typeof ext> = {}) {
  Object.assign(ext, { installed: true, allowed: true }, patch);
  calls.length = 0;
  delete fakeWindow.stellar;
}

const lib = () => import("./freighter");

test("signTransaction checks isAllowed before it asks Freighter to sign", async () => {
  reset();
  const { freighterSignTransaction } = await lib();
  assert.equal(await freighterSignTransaction("XDR", "pass"), "SIGNED");
  assert.ok(calls.indexOf("REQUEST_ALLOWED_STATUS") >= 0);
  assert.ok(calls.indexOf("REQUEST_ALLOWED_STATUS") < calls.indexOf("SUBMIT_TRANSACTION"));
  assert.ok(!calls.includes("REQUEST_ACCESS"), "already allowed, no connect popup");
});

test("signTransaction requests access first when the grant is gone", async () => {
  reset({ allowed: false });
  const { freighterSignTransaction } = await lib();
  await freighterSignTransaction("XDR", "pass");
  const order = (t: string) => calls.indexOf(t);
  assert.ok(order("REQUEST_ALLOWED_STATUS") < order("REQUEST_ACCESS"));
  assert.ok(order("REQUEST_ACCESS") < order("SUBMIT_TRANSACTION"));
});

test("signMessage requests access first when the grant is gone", async () => {
  reset({ allowed: false });
  const { freighterSignMessage } = await lib();
  await freighterSignMessage("hello", "GADDR");
  assert.ok(calls.indexOf("REQUEST_ACCESS") < calls.indexOf("SUBMIT_BLOB"));
});

test("access state: ready, needs-connect, not-installed", async () => {
  const { freighterAccessState } = await lib();
  reset();
  assert.equal(await freighterAccessState(), "ready");
  reset({ allowed: false });
  assert.equal(await freighterAccessState(), "needs-connect");
  reset({ installed: false });
  assert.equal(await freighterAccessState(), "not-installed");
});

test("the mobile in-app browser is always ready and never probes the extension", async () => {
  reset({ allowed: false });
  fakeWindow.stellar = { provider: "freighter", platform: "mobile" };
  const { freighterAccessState } = await lib();
  assert.equal(await freighterAccessState(), "ready");
  assert.equal(calls.length, 0);
});
