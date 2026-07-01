# frontend-send — Test Results

## Backend

```
# tests 33
# suites 9
# pass  33
# fail  0
```

CORS addition and `POST /commitment` import did not break existing tests. The
`/commitment` route is not unit-tested automatically (requires `pnpm build:circuits`
which produces the 2.5 MB wasm artifact not committed to the repo); manual test
deferred to e2e-demo.

## Frontend

```
next build
✓ Compiled successfully in 1442ms
✓ Type-check passed
✓ Static pages generated (5/5)
```

Build output:
```
Route (app)          Size    First Load JS
/ (redirect)         123 B       102 kB
/send                192 kB      294 kB
```

No TypeScript errors. No webpack warnings.

## Manual test

Not yet run (requires Freighter browser extension + deployed testnet contract +
`pnpm build:circuits`). Full UI test deferred to e2e-demo feature.
