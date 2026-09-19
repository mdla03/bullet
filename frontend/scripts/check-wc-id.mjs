// Does this Reown project id actually authorize the WalletConnect relay?
// Usage: node check-wc-id.mjs <projectId>
// Independent of Freighter and of any phone: this only proves the id works.
import { SignClient } from "@walletconnect/sign-client";

const projectId = process.argv[2];
if (!projectId) {
  console.error("usage: node check-wc-id.mjs <projectId>");
  process.exit(2);
}

const timeout = setTimeout(() => {
  console.error("FAIL  relay did not respond in 20s");
  process.exit(1);
}, 20_000);

try {
  const client = await SignClient.init({
    projectId,
    metadata: {
      name: "Bullet",
      description: "Private payments on Stellar.",
      url: "https://sendbullet.xyz",
      icons: ["https://sendbullet.xyz/logomark.svg"],
    },
  });

  // Same namespace lib/walletconnect.ts asks Freighter for.
  const { uri } = await client.connect({
    requiredNamespaces: {
      stellar: {
        methods: [
          "stellar_signMessage",
          "stellar_signXDR",
          "stellar_signAndSubmitXDR",
          "stellar_signAuthEntry",
        ],
        chains: ["stellar:testnet"],
        events: ["accountsChanged"],
      },
    },
  });

  clearTimeout(timeout);
  if (!uri?.startsWith("wc:")) {
    console.error("FAIL  no pairing uri returned");
    process.exit(1);
  }
  console.log("OK    relay accepted the project id");
  console.log("      pairing uri:", `${uri.slice(0, 60)}...`);
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  console.error("FAIL ", err?.message || err);
  process.exit(1);
}
