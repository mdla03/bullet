# resolver-service — Test Results

Command: `pnpm --filter @zeekpay/backend test`  
Runner: Node.js built-in (`node --import tsx/esm --test src/resolver.test.ts`)  
Date: 2026-07-01

```
TAP version 13
ok 1 - store.normalizeKey
  # 3 subtests pass
ok 2 - store.register + lookup
  # 5 subtests pass
ok 3 - GET /health
  # 1 subtest pass
ok 4 - GET /resolve
  # 4 subtests pass
ok 5 - POST /register
  # 6 subtests pass
1..5
# tests 19
# suites 5
# pass 19
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 486
```

All 19 tests pass. No failures.
