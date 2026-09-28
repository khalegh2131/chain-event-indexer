# Security

## Threat model

| Asset | Threat | Mitigation |
| --- | --- | --- |
| RPC credentials (`ETH_RPC_URL`, provider keys) | Leaked through logs, `/status`, or the repository | Never committed; `${ENV_VAR}` interpolation; `maskUrl`/`maskSecret`; pino `redact` for `rpcUrl`, `DATABASE_URL`, `password`, `x-api-key`, `authorization`, cookies |
| Database credentials | Leaked the same way | `DATABASE_URL` is redacted by the logger; the connection string never appears in an API response |
| Indexed data | Unauthorized reads | Optional API key on `/api/v1`, `/events`, `/metrics`, `/docs` |
| API surface | Credential stuffing / timing oracle | SHA-256 both operands then `crypto.timingSafeEqual` |
| Process integrity | Injection through query parameters | Parameterized SQL only; Zod validation; no string interpolation of user input into SQL |
| Availability | Hung database or provider | Bounded request timeouts, bounded health probe, retry ceilings, per-cycle batch budget |
| Chain integrity | Acting on unfinalized data | `confirmations` threshold before any block is considered processable |
| Key material | Signing, sending transactions, draining funds | Impossible by construction: the service holds no keys and only calls read methods (`eth_blockNumber`, `eth_getLogs`) |

## What this service does *not* do

- No private keys, mnemonics or signing.
- No `eth_sendRawTransaction`, `eth_sendTransaction` or any write RPC.
- No wallet, no custody, no fund movement.
- No outbound calls other than the configured RPC endpoints and PostgreSQL.

## Authentication

Enabled by setting `API_KEY`. Empty/unset ⇒ the API is open (development).

| Route | Protected |
| --- | --- |
| `/health` | no (probes must work without a credential) |
| `/status` | no (see `docs/DECISIONS.md` §5.7) |
| `/events`, `/api/v1/events` | yes |
| `/metrics` | yes |
| `/docs`, `/docs/json` | yes |

```bash
# Generate a key
openssl rand -hex 32

# Use it
export API_KEY=$(openssl rand -hex 32)
curl -s -H "x-api-key: $API_KEY" http://localhost:3000/api/v1/events
```

Implementation notes (`src/server/auth.ts`):

- Protected prefixes are `/api/v1`, `/events`, `/metrics`, `/docs`; matched on the
  path only (the query string is stripped).
- Both the supplied and the expected key are SHA-256 hashed before
  `timingSafeEqual`, so keys of different lengths are compared without leaking
  length, and the comparison time does not depend on the prefix match.
- A missing or empty header is a `401` with the standard envelope.

Not implemented (documented, deliberate): mTLS, JWT/OIDC, per-key rate limiting,
per-key scopes. Add a reverse proxy or an API gateway if those are required; this
service is designed to sit behind one.

## Secret hygiene

- `.env` and `config/config.json` are git-ignored; only `*.example` files are
  committed.
- The config loader never logs values; it logs the path and the counts.
- `maskUrl` rewrites credentials, sensitive query parameters
  (`key|token|secret|apikey|auth|password`) and long opaque path segments before
  any URL is formatted into a message.
- pino redaction covers `req.headers["x-api-key"]`, `req.headers.authorization`,
  `req.headers.cookie`, `rpcUrl`, `*.rpcUrl`, `DATABASE_URL`, `databaseUrl` and
  `password` (including nested forms).
- Error responses never contain stack traces. In production (`NODE_ENV=production`)
  every `5xx` is reported as `Internal server error`; the detail goes to the log
  with the request id.

## Input validation

| Layer | Control |
| --- | --- |
| Config | zod `.strict()` schemas, `viem.isAddress`, `viem.parseAbiItem`, duplicate and cross-reference checks |
| Query parameters | zod `.strict()` (unknown parameters are a `400`), explicit ranges for `limit`, `^\d+$` for block quantities, `0x` + 64 hex for hashes, canonical-cursor check |
| SQL | Parameterized statements only, with explicit casts (`$1::numeric`, `$n::bigint`); no identifier is built from user input |
| Bodies | No write endpoints exist; `bodyLimit` is 1 MiB |

## Transport and deployment hardening

The service speaks plain HTTP. Terminate TLS in front of it, and prefer:

- Running the container as the non-root `indexer` user (already the case, uid 10001).
- Publishing the API only on an internal network; expose `/health` (and `/status`)
  to the load balancer.
- Setting `API_KEY` whenever `/api/v1` is reachable beyond a trusted network.
- Using a dedicated read-only RPC endpoint/key per environment, with provider-side
  spend and rate limits.
- Giving the database user only what it needs: `SELECT, INSERT, UPDATE, DELETE` on
  the four tables plus `CREATE` for the migration user, and nothing at cluster level.
- Not exposing the PostgreSQL port publicly (`docker compose` publishes 5432 for
  local development only).

## Database-level safety

- `event_logs` inserts use `ON CONFLICT DO NOTHING`; there is no code path that
  deletes or updates event rows.
- `contracts` deletion cascades to `event_logs` and `ingestion_state` by explicit
  foreign keys (`ON DELETE CASCADE`).
- The cursor is monotonic (`GREATEST`), so a compromised or buggy writer cannot
  make the indexer skip forward.
- `last_finalized_block = -1` is the only non-positive value allowed; queries clamp
  `fromBlock` to `>= 0`.

## Logging and privacy

`event_logs.data` and `args` are public on-chain data, so logging a transaction
hash is not a disclosure. What is treated as sensitive: RPC URLs and keys,
database URLs, the API key, and cookies — all redacted.

## Dependency and supply-chain posture

- Runtime dependencies: `fastify`, `@fastify/swagger`, `@fastify/swagger-ui`,
  `pg`, `pino`, `prom-client`, `viem`, `zod`.
- Dev dependencies: `eslint`, `typescript`, `vitest`, `tsx`, `prettier`, types.
- `npm ci` with a committed lockfile; the production image installs with
  `npm ci --omit=dev` in a separate stage, so build tooling never ships.
- `npm audit` / Dependabot are recommended as a routine:

```bash
npm audit --omit=dev
```

## Reporting a vulnerability

Do not open a public issue for a security problem. Contact the maintainer
privately — **Khaleq Salehi, [khaleq.sa@gmail.com](mailto:khaleq.sa@gmail.com),
phone / WhatsApp / Telegram +98 912 014 3697** — with: affected version/commit,
reproduction steps, impact, and any suggested fix. Please allow a reasonable
window before disclosure.

## Security checklist before going live

- [ ] `API_KEY` set to ≥ 32 random bytes (or an equivalent gateway policy).
- [ ] TLS terminated in front of the service; the container port is not public.
- [ ] `NODE_ENV=production`.
- [ ] RPC URLs supplied only through the environment, ideally with provider-side
      rate limits and spend caps.
- [ ] Database reachable only from the app network; least-privilege DB user.
- [ ] `npm audit --omit=dev` reviewed.
- [ ] Backups enabled and a restore has been rehearsed (`docs/OPERATIONS.md`).
- [ ] Log aggregation configured; confirm no secret appears in a sample of lines.
- [ ] `confirmations` reviewed per chain.
