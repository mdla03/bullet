# resolver-service — Changes

## Files added / modified

### `backend/src/store.ts` (new)
In-memory registry backed by JSON file.

- `normalizeKey(q)` — trims, lowercases, preserves leading `@`
- `lookup(key)` — returns `Entry | undefined`
- `register(entry)` — writes to Map + flushes to `REGISTRY_FILE`; returns `{ok:true}` or `{conflict:true, detail}`
- Conflict rule: same key pointing to **different** Stellar address → conflict. Same address → idempotent.
- File path: `backend/data/registry.json` (gitignored); overridden in tests via `REGISTRY_FILE_OVERRIDE` env var.
- Loads from file on module init via `load()`.

### `backend/src/resolver.ts` (new)
Express 5 HTTP server.

| Route | Behaviour |
|-------|-----------|
| `GET /health` | `{ok:true}` |
| `GET /resolve?q=` | Normalizes `q`, looks up in store. `{found:false}` or full `ResolveResult`. |
| `POST /register` | Validates input, calls `store.register`, returns `200 {ok:true}` / `400` / `409`. |

- Auto-starts only when run directly (`process.argv[1] === import.meta.url`), not on import.
- `CONTRACT_ADDRESS` and `USDC_SAC` from env vars; empty string if unset.

### `backend/src/resolver.test.ts` (new)
19 test cases, Node built-in test runner.

- Unit: `normalizeKey` (3), `register + lookup` (5)
- HTTP: `/health` (1), `/resolve` (4), `/register` (6)
- Server bound to port 0; actual port read from `server.address()`.

### `backend/tsconfig.json` (new)
`NodeNext` module + strict mode.

### `backend/package.json` (modified)
Scripts: `dev` → `tsx watch`, `test` → node `--import tsx/esm --test`, `build` → `tsc`.

### `shared/src/index.ts` (modified)
Added `ResolveResult` and `RegisterRequest` types.

### `backend/data/.gitkeep` (new)
Tracks `data/` directory; `registry.json` and test JSON gitignored.

### `.gitignore` (modified)
Added `backend/data/registry.json` and `backend/data/_test_registry.json`.

## Design decisions

- **No DB**: in-memory Map + JSON file. Zero infrastructure cost. Acceptable for MVP scale (<10k users).
- **Signature stored but not verified**: deferred to `x-oauth-identity` feature which adds OAuth proof.
- **`REGISTRY_FILE_OVERRIDE` env var**: lets tests point store at a temp path without any mocking.
- **Port 0 in tests**: OS assigns free port; no hardcoded port conflicts.
