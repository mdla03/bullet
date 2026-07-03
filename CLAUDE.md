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

## UI rules

- Dark theme: zinc-950 background, amber-400 accent, Tailwind utility classes
  only (no custom CSS unless unavoidable).
- Icons: Lucide path data copied verbatim into `frontend/src/components/icons.tsx`.
  Never hand-draw SVG paths, never add an icon dependency.
- Before designing a new screen, check Refero (MCP) for real-app references
  first. Do not invent layouts from scratch when a proven pattern exists.
