# x-oauth-identity — Test Results

Command: `pnpm --filter @zeekpay/backend test`  
Runner: Node.js built-in (`node --import tsx/esm --test src/resolver.test.ts`)  
Date: 2026-07-01

```
TAP version 13
ok 1 - store.normalizeKey           # 3 subtests
ok 2 - store.register + lookup      # 5 subtests
ok 3 - GET /health                  # 1 subtest
ok 4 - GET /resolve                 # 4 subtests
ok 5 - POST /register               # 6 subtests
ok 6 - verify.buildChallenge        # 1 subtest
ok 7 - verify.verifyRegistrationSig # 4 subtests
ok 8 - POST /auth/twitter/start     # 6 subtests
ok 9 - GET /auth/twitter/callback   # 3 subtests
1..9
# tests 33
# suites 9
# pass 33
# fail 0
# duration_ms 634
```

All 33 tests pass (19 pre-existing + 14 new). No regressions.

## New test coverage

| Suite | Tests | What's covered |
|-------|-------|----------------|
| `verify.buildChallenge` | 1 | Canonical challenge string format |
| `verify.verifyRegistrationSig` | 4 | Valid sig, mutated sig, wrong keypair, invalid address |
| `POST /auth/twitter/start` | 6 | Happy path authUrl, wrong sig, bad sig length, bad address, missing @, 503 unconfigured |
| `GET /auth/twitter/callback` | 3 | Expired state, user-cancelled, missing params |

Twitter token exchange + `/users/me` call not unit-tested (requires live credentials). Covered in e2e-demo.
