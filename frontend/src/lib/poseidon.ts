// Browser port of backend/src/poseidon.ts. BLS12-381 Poseidon that matches the
// on-chain claim circuit; used to compute the nullifier client-side so the
// secret never leaves the browser.

// @ts-expect-error — ffjavascript ships no types.
import { ZqField } from "ffjavascript";
import rawConstants from "./poseidon_constants_opt.json";

const BLS_R =
  52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const F = new ZqField(BLS_R);
const ZERO = F.zero as bigint;

const N_ROUNDS_F = 8;
const N_ROUNDS_P = [56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68];

const CS: bigint[][] = (rawConstants as { C: string[][] }).C.map((row) =>
  row.map((s) => F.e(s) as bigint)
);
const SS: bigint[][] = (rawConstants as { S: string[][] }).S.map((row) =>
  row.map((s) => F.e(s) as bigint)
);
const MS: bigint[][][] = (rawConstants as { M: string[][][] }).M.map((mat) =>
  mat.map((row) => row.map((s) => F.e(s) as bigint))
);
const PS: bigint[][][] = (rawConstants as { P: string[][][] }).P.map((mat) =>
  mat.map((row) => row.map((s) => F.e(s) as bigint))
);

function pow5(x: bigint): bigint {
  const x2 = F.mul(x, x);
  const x4 = F.mul(x2, x2);
  return F.mul(x4, x);
}

export function poseidon(inputs: (string | bigint)[]): string {
  if (inputs.length < 1 || inputs.length > N_ROUNDS_P.length) {
    throw new Error(`poseidon: input width ${inputs.length} out of range`);
  }
  const t = inputs.length + 1;
  const nRoundsP = N_ROUNDS_P[t - 2];
  const C = CS[t - 2];
  const S = SS[t - 2];
  const M = MS[t - 2];
  const P = PS[t - 2];

  let state: bigint[] = [ZERO, ...inputs.map((x) => F.e(x) as bigint)];
  state = state.map((a, i) => F.add(a, C[i]) as bigint);

  for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
    state = state.map((a) => pow5(a));
    state = state.map((a, i) => F.add(a, C[(r + 1) * t + i]) as bigint);
    const next: bigint[] = new Array(t);
    for (let i = 0; i < t; i++) {
      let acc = ZERO;
      for (let j = 0; j < t; j++) acc = F.add(acc, F.mul(M[j][i], state[j])) as bigint;
      next[i] = acc;
    }
    state = next;
  }

  state = state.map((a) => pow5(a));
  state = state.map((a, i) => F.add(a, C[(N_ROUNDS_F / 2 - 1 + 1) * t + i]) as bigint);
  {
    const next: bigint[] = new Array(t);
    for (let i = 0; i < t; i++) {
      let acc = ZERO;
      for (let j = 0; j < t; j++) acc = F.add(acc, F.mul(P[j][i], state[j])) as bigint;
      next[i] = acc;
    }
    state = next;
  }

  for (let r = 0; r < nRoundsP; r++) {
    state[0] = pow5(state[0]);
    state[0] = F.add(state[0], C[(N_ROUNDS_F / 2 + 1) * t + r]) as bigint;
    let s0 = ZERO;
    for (let j = 0; j < t; j++) {
      s0 = F.add(s0, F.mul(S[(t * 2 - 1) * r + j], state[j])) as bigint;
    }
    for (let k = 1; k < t; k++) {
      state[k] = F.add(state[k], F.mul(state[0], S[(t * 2 - 1) * r + t + k - 1])) as bigint;
    }
    state[0] = s0;
  }

  for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
    state = state.map((a) => pow5(a));
    state = state.map(
      (a, i) => F.add(a, C[(N_ROUNDS_F / 2 + 1) * t + nRoundsP + r * t + i]) as bigint
    );
    const next: bigint[] = new Array(t);
    for (let i = 0; i < t; i++) {
      let acc = ZERO;
      for (let j = 0; j < t; j++) acc = F.add(acc, F.mul(M[j][i], state[j])) as bigint;
      next[i] = acc;
    }
    state = next;
  }

  state = state.map((a) => pow5(a));
  {
    const next: bigint[] = new Array(t);
    for (let i = 0; i < t; i++) {
      let acc = ZERO;
      for (let j = 0; j < t; j++) acc = F.add(acc, F.mul(M[j][i], state[j])) as bigint;
      next[i] = acc;
    }
    state = next;
  }

  let out = BigInt(F.toString(state[0]));
  out = ((out % BLS_R) + BLS_R) % BLS_R;
  return out.toString();
}

export { BLS_R };
