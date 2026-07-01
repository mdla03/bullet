# frontend-claim — Test Results

## Backend

```
# tests 33  # pass 33  # fail 0
```

`POST /prove` and `POST /post-root` routes are not unit-tested automatically:
- `/prove` requires `pnpm build:circuits` artifacts (claim.wasm + claim.zkey).
- `/post-root` requires `ZEEKPAY_ADMIN_KEY` and a live testnet RPC.
Both are tested end-to-end in the e2e-demo feature.

## Backend TypeScript

```
tsc — no errors
```

## Frontend

```
next build
✓ Compiled successfully
✓ Type-check passed
✓ Static pages generated (6/6)
```

```
Route (app)     Size    First Load JS
/claim          3.04 kB   295 kB   (ƒ dynamic)
/send           2.83 kB   294 kB
```

Fix applied: `rpc.pollTransaction(hash, { attempts: 30 })` — `sleepTime` is
not in `PollingOptions`; only `attempts` and `sleepStrategy` are valid.

## Manual

Full claim flow deferred to e2e-demo (requires deployed contract, funded admin
account, Freighter extension, and `pnpm build:circuits`).
