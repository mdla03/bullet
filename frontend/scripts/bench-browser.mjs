// Drives the /bench page in a real headless Chrome and prints the numbers.
//
// This is the automated form of D1's required in-browser proving-time
// benchmark. It is a real browser executing the real circuit wasm, not a
// Node snarkjs proxy, which is the distinction the SOW cares about.
//
// Prereqs:
//   1. artifacts staged (they are gitignored):
//        mkdir -p frontend/public/circuits/bench
//        cp circuits/build/claim_js/claim.wasm circuits/build/claim.zkey \
//           circuits/build/claim_input.json circuits/build/claim_vk.json \
//           frontend/public/circuits/bench/
//   2. dev server up:  pnpm --filter @bullet/frontend dev
//
// Run: node frontend/scripts/bench-browser.mjs [runs]

import puppeteer from "puppeteer-core";

const URL = process.env.BENCH_URL ?? "http://localhost:3000/bench";
const RUNS = Number(process.argv[2] ?? 5);
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Proving holds the main thread for seconds at a time; the default 30s
// protocol timeout trips well before a 5-run sweep finishes.
const NAV_TIMEOUT = 120_000;
const RUN_TIMEOUT = 10 * 60_000;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
  protocolTimeout: RUN_TIMEOUT,
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  const failures = [];
  page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) =>
    failures.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`)
  );

  const res = await page.goto(URL, { waitUntil: "networkidle0" });
  if (!res || !res.ok()) {
    throw new Error(
      `${URL} returned ${res?.status()}. Is the dev server running?`
    );
  }

  // Set the run count, then start.
  await page.waitForSelector("#runs");
  // Set through the native setter and fire `input`, so React's onChange sees
  // it. Typing appends to the existing value and gets clamped to max instead.
  await page.$eval(
    "#runs",
    (el, v) => {
      const set = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      set.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    RUNS
  );
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Run benchmark")
    );
    if (!btn) throw new Error("Run benchmark button not found");
    btn.click();
  });

  // Done when either the proof-check card or the failure card lands.
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("groth16.verify returned") ||
      document.body.innerText.includes("Failed"),
    { timeout: RUN_TIMEOUT, polling: 500 }
  );

  const text = await page.evaluate(() => document.body.innerText);

  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  const runs = [...text.matchAll(/run \d+(?: \(cold\))?\s+([\d,]+) ms/g)].map(
    (m) => Number(m[1].replace(/,/g, ""))
  );

  const out = {
    url: URL,
    userAgent: await page.evaluate(() => navigator.userAgent),
    loadMs: num(/fetch \+ decode\s+([\d,]+) ms/),
    runsMs: runs,
    medianAllMs: num(/median, all runs\s+([\d,]+) ms/),
    medianWarmMs: num(/median, excluding cold\s+([\d,]+) ms/),
    verified: /groth16\.verify returned true/.test(text),
    publicSignals: num(/(\d+) public signals/),
    pageFailures: failures,
  };

  console.log(JSON.stringify(out, null, 2));

  // A benchmark that timed an invalid proof is worse than no benchmark.
  if (!out.verified) throw new Error("groth16.verify did not return true");
  if (out.publicSignals !== 6) {
    throw new Error(`expected 6 public signals, got ${out.publicSignals}`);
  }
  if (!out.runsMs.length) throw new Error("no per-run timings scraped");
} finally {
  await browser.close();
}
