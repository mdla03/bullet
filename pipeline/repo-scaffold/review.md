# repo-scaffold — Review (review.md)

## Fresh-eyes diff read
25 files, no product logic. Nothing looks off after the two Test-stage fixes.
Structure matches the kickoff brief layout exactly. Lockfiles committed (good).

## Security checklist
| Item | Status |
|------|--------|
| Secrets gitignored (`.env`, `.env.*`, `*.secret`, `stellar-keys/`) | ✓ verified via `git check-ignore` |
| `.env.example` carries NO real values | ✓ all blank |
| `!.env.example` survives the `.env.*` glob | ✓ verified TRACKED |
| Toxic-waste ptau contributions ignored | ✓ `*.ptau`, `*_contribution_*`, `contributions/` all IGNORED |
| Only `final.ptau` (public) survives | ✓ verified TRACKED (after inline-comment fix) |
| Build artifacts ignored (`target/`, `.next/`, `node_modules/`, `dist/`) | ✓ |
| `pipeline/` NOT ignored | ✓ both pipeline files TRACKED |
| No secret in the would-commit set | ✓ dry-run = 25 clean files |
| Nullifier / verifier / key-derivation logic | n/a — no product code yet |

**No secrets and no toxic-waste artifacts can be committed with this `.gitignore`.**
The two bugs that could have leaked the safe-vs-unsafe boundary (broken
negations) were caught before any commit.

## Code quality
- Naming consistent (`@zeekpay/*` scope, feature-referenced script stubs).
- No dead code; stubs are intentional and comment-pointed at their owning feature.
- No dependencies added — zero supply-chain surface in the scaffold.
- Release profile in `contracts/Cargo.toml` pre-tuned for Soroban wasm size.

## Issues found & resolved (this feature)
1. `#![no_std]` stubs failed host build → switched to `std` stubs. (Test §1)
2. `.gitignore` trailing inline comments broke 2 negations → comments to own
   lines. (Test §3) **Highest-value catch** — directly protects the
   toxic-waste / secrets boundary.

## Open risk — needs owner awareness
- **Node version mismatch:** `engines` pins `>=20 <21` (owner: pin Node 20 LTS),
  but this env runs **Node 22**. pnpm didn't hard-fail (not engine-strict), but
  this will warn — or block under `engine-strict=true`. **Decision needed:**
  keep the 20-LTS pin (and run the build on Node 20), or loosen to `>=20`?
  Left as the owner pinned it; flagging rather than silently widening.
  **Resolved:** owner chose to loosen to `node: ">=20"`. Applied.

## README accuracy
README describes reality: stack, layout, honest privacy notes, setup steps all
match what exists. The privacy section reflects the owner's amended SPEC
(one-time commitments, fixed-denom = amount-unlinkability only, encrypted = P3,
email trusted, X copy-paste, own Groth16 setup). ✓

## Recommended follow-ups (NOT built — noted only)
- CI workflow: `cargo build` + `pnpm install` + a `git check-ignore` regression
  test for the secrets/toxic-waste matrix (P1 polish).
- `rustfmt.toml` / `.editorconfig` for cross-editor consistency.
- Pre-commit hook scanning staged diff for high-entropy strings (secret guard).

## Verdict
**repo-scaffold complete.** `.gitignore` proven correct, build green, workspace
wired. Ready to commit. Next gate: `verifier-benchmark` (Groth16 go/no-go).
