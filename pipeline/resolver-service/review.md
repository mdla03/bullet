# resolver-service — Review

## Security checklist

| # | Item | Status |
|---|------|--------|
| 1 | No secrets in code | ✅ All config via env vars |
| 2 | No SQL injection surface | ✅ No SQL; Map keys only |
| 3 | Input validation on all POST fields | ✅ Stellar key regex, hex key regex, email regex |
| 4 | No plaintext credentials stored | ✅ Signature stored but it's a public blob |
| 5 | No mainnet/paid APIs | ✅ Pure local store |
| 6 | No files >1MB committed | ✅ registry.json gitignored |
| 7 | No XSS surface (JSON API only) | ✅ Content-Type: application/json throughout |

## Known gaps (deferred to later features)

| Gap | Deferred to |
|-----|-------------|
| Signature not verified | `x-oauth-identity` — will verify Freighter Ed25519 sig |
| No rate limiting on POST /register | P1 / before public launch |
| No authentication on who can register | `x-oauth-identity` adds OAuth proof |
| Data dir not created on cold start | `persist()` calls `mkdirSync({recursive: true})` — covered |
| registry.json not encrypted at rest | Acceptable for MVP; contains only public Stellar keys + handles |
| No HTTPS | Handled by reverse proxy (Caddy/nginx) in production |

## Code quality notes

- `REGISTRY_FILE_OVERRIDE` env var cleanly separates test/prod data — no mocking required.
- Auto-listen guarded by `process.argv[1]` check — prevents double-bind in tests.
- `persist()` is synchronous — acceptable for low-write MVP; swap to async queue if write rate increases.
