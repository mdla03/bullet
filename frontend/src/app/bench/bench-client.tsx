"use client";

import { useState } from "react";
// @ts-expect-error — snarkjs has no bundled types.
import * as snarkjs from "snarkjs";

const BASE = "/circuits/bench";
const DEFAULT_RUNS = 5;

type Phase = "idle" | "loading" | "proving" | "verifying" | "done" | "error";

interface Result {
  loadMs: number;
  wasmBytes: number;
  zkeyBytes: number;
  runs: number[];
  verified: boolean;
  publicSignals: string[];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const ms = (n: number) => `${n.toFixed(0)} ms`;
const mb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;

export default function Bench() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [runCount, setRunCount] = useState(DEFAULT_RUNS);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPhase("loading");
    setResult(null);
    setError(null);
    setProgress(0);

    try {
      // Phase 1: fetch the circuit assets. Timed separately because a real
      // user pays this once per session before any proving starts.
      const t0 = performance.now();
      const [wasmRes, zkeyRes, inputRes, vkRes] = await Promise.all([
        fetch(`${BASE}/claim.wasm`),
        fetch(`${BASE}/claim.zkey`),
        fetch(`${BASE}/claim_input.json`),
        fetch(`${BASE}/claim_vk.json`),
      ]);
      for (const [name, res] of [
        ["claim.wasm", wasmRes],
        ["claim.zkey", zkeyRes],
        ["claim_input.json", inputRes],
        ["claim_vk.json", vkRes],
      ] as const) {
        if (!res.ok) {
          throw new Error(
            `${name} missing (${res.status}). Copy the artifacts into public/circuits/bench first, see the comment in page.tsx.`
          );
        }
      }
      const [wasmBuf, zkeyBuf, input, vk] = await Promise.all([
        wasmRes.arrayBuffer(),
        zkeyRes.arrayBuffer(),
        inputRes.json(),
        vkRes.json(),
      ]);
      const wasm = new Uint8Array(wasmBuf);
      const zkey = new Uint8Array(zkeyBuf);
      const loadMs = performance.now() - t0;

      if (input.blinding === undefined || input.amountCommitment === undefined) {
        throw new Error(
          "Input vector has no blinding / amountCommitment. This is the old 5-input build, not the circuit under test."
        );
      }

      // Phase 2: prove, N times. Run 1 carries one-time wasm instantiation, so
      // it is reported separately from the warm median rather than discarded.
      setPhase("proving");
      const runs: number[] = [];
      let last: { proof: unknown; publicSignals: string[] } | null = null;
      for (let i = 0; i < runCount; i++) {
        const t = performance.now();
        last = await snarkjs.groth16.fullProve(input, wasm, zkey);
        runs.push(performance.now() - t);
        setProgress(i + 1);
      }

      // Phase 3: verify one proof. Without this the timings could be measuring
      // a prover that produces garbage quickly.
      setPhase("verifying");
      const verified: boolean = await snarkjs.groth16.verify(
        vk,
        last!.publicSignals,
        last!.proof
      );

      setResult({
        loadMs,
        wasmBytes: wasm.byteLength,
        zkeyBytes: zkey.byteLength,
        runs,
        verified,
        publicSignals: last!.publicSignals,
      });
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const busy = phase === "loading" || phase === "proving" || phase === "verifying";
  const warm = result && result.runs.length > 1 ? result.runs.slice(1) : null;

  return (
    <main className="min-h-screen bg-paper text-ink px-6 py-12">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold tracking-tight">
          In-browser proving benchmark
        </h1>
        <p className="mt-3 text-graphite">
          Times <span className="font-mono">groth16.fullProve</span> in this tab
          against the 6-public-input claim circuit. Local only, and it does not
          touch the artifacts the live claim flow uses.
        </p>

        <div className="mt-8 flex items-center gap-3">
          <label htmlFor="runs" className="text-sm text-graphite">
            Runs
          </label>
          <input
            id="runs"
            type="number"
            min={1}
            max={25}
            value={runCount}
            onChange={(e) =>
              setRunCount(Math.max(1, Math.min(25, Number(e.target.value) || 1)))
            }
            disabled={busy}
            className="w-20 rounded-xl border border-fog bg-white px-3 py-2 font-mono text-sm disabled:opacity-50"
          />
          <button
            onClick={run}
            disabled={busy}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper disabled:opacity-50"
          >
            {busy ? "Running" : "Run benchmark"}
          </button>
          {phase === "proving" && (
            <span className="font-mono text-sm text-graphite">
              {progress}/{runCount}
            </span>
          )}
          {phase === "loading" && (
            <span className="font-mono text-sm text-graphite">
              fetching assets
            </span>
          )}
        </div>

        {error && (
          <div className="mt-8 rounded-2xl border border-fog bg-white p-5">
            <p className="text-sm font-medium">Failed</p>
            <p className="mt-2 font-mono text-sm text-graphite">{error}</p>
          </div>
        )}

        {result && (
          <div className="mt-8 space-y-4">
            <div className="rounded-2xl border border-fog bg-white p-5">
              <h2 className="text-sm font-medium">Asset load</h2>
              <dl className="mt-3 space-y-1 font-mono text-sm">
                <div className="flex justify-between">
                  <dt className="text-graphite">fetch + decode</dt>
                  <dd>{ms(result.loadMs)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-graphite">claim.wasm</dt>
                  <dd>{mb(result.wasmBytes)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-graphite">claim.zkey</dt>
                  <dd>{mb(result.zkeyBytes)}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-graphite">
                Served from localhost, so this is a floor. Over a real network
                it is dominated by the {mb(result.wasmBytes + result.zkeyBytes)}{" "}
                download.
              </p>
            </div>

            <div className="rounded-2xl border border-fog bg-white p-5">
              <h2 className="text-sm font-medium">Proving time</h2>
              <table className="mt-3 w-full font-mono text-sm">
                <tbody>
                  {result.runs.map((r, i) => (
                    <tr key={i}>
                      <td className="py-1 text-graphite">
                        run {i + 1}
                        {i === 0 && result.runs.length > 1 ? " (cold)" : ""}
                      </td>
                      <td className="py-1 text-right">{ms(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 border-t border-fog pt-3 font-mono text-sm">
                <div className="flex justify-between font-medium">
                  <span>median, all runs</span>
                  <span>{ms(median(result.runs))}</span>
                </div>
                {warm && (
                  <div className="flex justify-between text-graphite">
                    <span>median, excluding cold</span>
                    <span>{ms(median(warm))}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-fog bg-white p-5">
              <h2 className="text-sm font-medium">Proof check</h2>
              <p className="mt-2 font-mono text-sm">
                {result.verified ? (
                  <span className="text-signal">
                    groth16.verify returned true
                  </span>
                ) : (
                  <span className="text-amber">
                    groth16.verify returned false. Timings above are not
                    measuring a valid proof.
                  </span>
                )}
              </p>
              <p className="mt-2 font-mono text-xs text-graphite">
                {result.publicSignals.length} public signals
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
