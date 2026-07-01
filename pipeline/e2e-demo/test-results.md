# e2e-demo — Test Results

## Backend API (verified via curl)

| Endpoint | Result |
|----------|--------|
| `GET /health` | `{"ok":true}` ✓ |
| `GET /resolve?q=@demo` | returns `stellarAddress` + `contractAddress` ✓ |
| `POST /prove` (secret=12345, rd=42, denom=10) | full proof in ~15 s ✓ |
| `POST /post-root` | `{"ok":true,"hash":"..."}`, `is_known_root=true` on-chain ✓ |

## Proof generation (test vector)

```
nullifier: 30210038655452570927876935731677491109181541264348558594944850742778338046562
root:      19148948013232879213203992136026734822699351263916619827234416357547906460635
proof_a len: 192 chars ✓
proof_b len: 384 chars ✓
proof_c len: 192 chars ✓
```

Matches pre-existing `groth16_soroban.json` (same test inputs → same root, same nullifier). ✓

## On-chain state

- Contract initialized ✓
- VK set (5-element IC, 4 public inputs matching circuit) ✓
- Test root posted and recognized (`is_known_root = true`) ✓

## Backend tests

```
# tests 33  # pass 33  # fail 0
```

## Browser demo

Not yet run — requires Freighter extension with a funded testnet account.
See demo instructions below.
