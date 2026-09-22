import assert from "node:assert/strict";
import test from "node:test";

import { Keypair } from "@stellar/stellar-base";

import { freighterDeepLink, sep53Digest } from "./walletconnect";

// Official SEP-53 test vectors, ecosystem/sep-0053.md "Test cases".
// These pin the exact preimage Freighter mobile signs. The first 32 bytes of
// that signature seed the user's Bullet keypair (register.ts
// deriveBulletPubKey), so a digest that is merely self-consistent is worthless:
// it has to match the spec byte for byte or mobile derives a different identity
// than the desktop extension and the user loses access to their own notes.
const ADDRESS = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";

const VECTORS = [
  {
    name: "ascii",
    message: "Hello, World!",
    signature:
      "fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==",
  },
  {
    // Multi-byte UTF-8: catches a preimage built from char counts or latin1.
    name: "utf-8",
    message: "こんにちは、世界！",
    signature:
      "CDU265Xs8y3OWbB/56H9jPgUss5G9A0qFuTqH2zs2YDgTm+++dIfmAEceFqB7bhfN3am59lCtDXrCtwH2k1GBA==",
  },
];

for (const v of VECTORS) {
  test(`sep53Digest matches the SEP-53 vector (${v.name})`, () => {
    const verified = Keypair.fromPublicKey(ADDRESS).verify(
      sep53Digest(v.message),
      Buffer.from(v.signature, "base64")
    );
    assert.equal(verified, true);
  });
}

// Freighter's own deep-link handler, copied from freighter-mobile
// src/hooks/useWalletKitEventsManager.ts onDeepLink(). A URL that does not
// survive this is dropped silently by the wallet: no prompt, no error, the
// dapp just sits there until its approval timeout. Pinning the parser rather
// than the string means a "tidier" URL that still looks right but stops
// matching gets caught here instead of on a phone.
const WALLET_KIT_MT_REDIRECT_NATIVE = "freighterwallet://wc-redirect";

function freighterPairsWith(url: string): string | null {
  if (!url?.includes(WALLET_KIT_MT_REDIRECT_NATIVE)) return null;
  const uriParam = new URL(url).search.split("uri=")[1];
  if (!uriParam) return null;
  return decodeURIComponent(uriParam);
}

test("the deep link survives Freighter's onDeepLink parser", () => {
  const uri = "wc:9b1f0a@2?relay-protocol=irn&symKey=deadbeef+/=";
  assert.equal(freighterPairsWith(freighterDeepLink(uri)), uri);
});

test("the generic wc?uri= convention would NOT have matched", () => {
  const uri = "wc:9b1f0a@2?relay-protocol=irn&symKey=deadbeef";
  const generic = `freighterwallet://wc?uri=${encodeURIComponent(uri)}`;
  assert.equal(freighterPairsWith(generic), null);
});

test("a different message does not verify", () => {
  const verified = Keypair.fromPublicKey(ADDRESS).verify(
    sep53Digest("Hello, World"),
    Buffer.from(VECTORS[0].signature, "base64")
  );
  assert.equal(verified, false);
});
