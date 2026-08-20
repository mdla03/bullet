# Bullet

ZK-private payment rail on Stellar. See SPEC.md for scope and architecture.
The product name is Bullet (not ZeekPay; package/crate names still carry the
old name until a coordinated rename).

## Copywriting rules (all user-facing text)

- NO em dashes (—) anywhere in copy. Use a period and a new sentence, or a
  comma. Middots (·) are fine as separators in titles.
- NO "LIVE" indicators: no pulsing dots, no LIVE/ONLINE badges, no
  fake-realtime status chips. If something is genuinely realtime, the data
  updating is the indicator.
- Not corny. No slogans in the UI chrome, no cutesy metaphors, no all-caps
  taglines. Plain, confident, factual sentences. Explain privacy mechanics in
  concrete terms ("nothing on-chain connects your deposit to their claim"),
  never in marketing speak.
- Be honest about privacy. Never claim more anonymity than the design gives
  (see SPEC.md threat model).

## Design system (brand sheet, 2026-07-03; follow exactly)

Light "paper" theme. Minimal, terminal-adjacent, trust through restraint.

- **Colors** (Tailwind tokens in `frontend/src/app/globals.css`, use by name):
  - `ink` #0A0A0A: text, primary buttons (bg-ink text-paper).
  - `paper` #F5F3EE: page background.
  - `fog` #E5E0DE: borders, dividers. Cards are `bg-white border-fog`.
  - `graphite` #6B6B6B: secondary text.
  - `signal` #00A676: action/status color, as text or a check icon. NO status
    dots, ever, not even static ones. They read as LIVE indicators.
  - `amber` #E8B54A: warnings only, sparingly.
- **Type**: Inter 400/500 body (font-sans), Geist Mono for addresses, hashes
  and status lines (font-mono). Amounts and headlines: Inter bold,
  tracking-tight. Taglines are lowercase with a period ("send silently.").
- **Logo**: the combined wordmark `frontend/public/wordmark.svg` is one unit;
  never place the logomark next to text spelling "bullet". Logomark
  `frontend/public/logomark.svg` is for square contexts only (favicon at
  `frontend/src/app/icon.svg`). Do not redraw either.
- **Shapes**: pill buttons (rounded-full), rounded-2xl cards, rounded-xl
  inputs. Tailwind utilities only, no custom CSS unless unavoidable.
- Icons: Lucide path data copied verbatim into `frontend/src/components/icons.tsx`
  (brand logos from Simple Icons). Never hand-draw SVG paths, never add an
  icon dependency.
- Before designing a new screen, check Refero (MCP) for real-app references
  first. Do not invent layouts from scratch when a proven pattern exists.

## Testing rules (money paths especially)

A test that asserts a failure is worthless until you have watched it fail for
the right reason. This has bitten three times: an assertion on
`Error::InvalidAmount` passed because the SAC's own error code 10 decodes to
the same value; a drain test passed because the pool was empty rather than
because the guard worked; an ordering test passed because the fixture had
three zeroes in the slots being swapped.

- **Mutate to verify.** After writing a test that guards something, break the
  thing it guards and confirm the test fails. Restore, confirm it passes. If
  it passes both ways it is testing nothing.
- **Assert on the specific site, not a generic outcome.** For circuits, pin
  the constraint line (`circuits/scripts/gen-joinsplit-vectors.mjs` declares
  an `expectAt` per vector and rejects a failure anywhere else). For
  contracts, assert on balances and state rather than error codes, which
  collide across contracts.
- **Make failure paths reachable.** Over-fund the pool so a drain is blocked
  by the guard rather than by an insufficient balance. Use distinct non-zero
  values so a reordering is detectable.
- **Check the test count** before and after any structural edit to a test
  file. A silently deleted test looks exactly like a passing suite.

## Repo conventions that have guards

- **No direct commits to master.** A `pre-commit` hook enforces it. Two
  worktrees share this `.git` (`bullet` on master, `bullet-d1` on a feature
  branch), so check `git worktree list` before assuming the branch is wrong.
  Deliberate exception: `ALLOW_MASTER_COMMIT=1 git commit`.
- **`groth16_fixture.rs` is pinned at 5 public inputs on purpose.**
  `convert-to-soroban.mjs` refuses to regenerate it without `FORCE_FIXTURE=1`.
  It must only change as part of the coordinated contract + circuit + set_vk +
  frontend change described in `pipeline/circom-circuit/changes.md`.
- **Move work between worktrees with git**, via cherry-pick or stash. Never by
  slicing source files with a script; that dropped six tests once already.
