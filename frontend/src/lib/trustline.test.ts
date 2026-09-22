// Run: node --import tsx/esm --test src/lib/trustline.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAssetName } from "./trustline";

describe("parseAssetName", () => {
  it('parses "CODE:ISSUER" into a ClaimAsset', () => {
    const issuer = "GBVT4SSY5SEIN73DCFCY3ZWTX3NHNAFRHFFAWRZI6JXCPD5D3EW7HJ32";
    assert.deepEqual(parseAssetName(`USDT:${issuer}`), { code: "USDT", issuer });
  });

  it('short-circuits "native" to null (no trustline needed), purely, with no network call', () => {
    assert.equal(parseAssetName("native"), null);
  });

  it("throws on a malformed name with no issuer half", () => {
    // Picked "throw" over "return null" here: an unparseable name() response
    // means the SAC returned something this app doesn't understand, which is
    // not the same as the confirmed "no trustline needed" that "native" is.
    assert.throws(() => parseAssetName("USDT"));
  });

  it("throws on a malformed name with an empty code", () => {
    assert.throws(() =>
      parseAssetName(":GBVT4SSY5SEIN73DCFCY3ZWTX3NHNAFRHFFAWRZI6JXCPD5D3EW7HJ32")
    );
  });
});
