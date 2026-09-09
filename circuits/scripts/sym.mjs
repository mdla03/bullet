// Shared .sym file parser. A .sym file maps witness signal names to their
// index in the witness array (circom's compiler output). Parsed once per
// path and memoized, since gen-test-proof.mjs and the jubjub tests both read
// the same .sym files repeatedly.
import fs from "fs";

const cache = new Map();

/** Signal name -> witness index for the .sym file at `symPath`. */
export function symIndex(symPath) {
  if (cache.has(symPath)) return cache.get(symPath);
  const lines = fs.readFileSync(symPath, "utf8").trim().split("\n");
  const index = {};
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 4) continue;
    index[parts[3].trim()] = parseInt(parts[0], 10);
  }
  cache.set(symPath, index);
  return index;
}
