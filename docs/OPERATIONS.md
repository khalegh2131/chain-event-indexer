# Operations

Runbook for running `chain-event-indexer` in production: deployment, migrations,
monitoring, backups, scaling and rollback.

## Contents

- [Deployment shapes](#deployment-shapes)
- [Configuration checklist](#configuration-checklist)
- [Starting and stopping](#starting-and-stopping)
- [Migrations](#migrations)
- [Health, status and metrics](#health-status-and-metrics)
- [Logs](#logs)
- [Backup and restore](#backup-and-restore)
- [Scaling](#scaling)
- [Rollback](#rollback)
- [Incident playbook](#incident-playbook)
- [Docker reference](#docker-reference)

---

## Deployment shapes

| Shape | Poller | Typical use |
| --- | --- | --- |
| Single container | `POLLER_ENABLED=true` | MVP, low volume, one chain |
| API replicas + one worker | API replicas `false`, worker `true` | Horizontal API scaling |
| N workers, one per chain | Each worker `false` + `filterChainIds` per chain | High volume, many chains |

Multiple pollers against the same database are **safe**: the unique key
`(chain_id, tx_hash, log_index)` makes concurrent inserts idempotent, and the
cursor only moves forward. Duplicated work is possible, duplicated data is not.

## Configuration checklist

Before starting in production:

- [ ] `DATABASE_URL` points at a managed/backed-up PostgreSQL 16 instance.
- [ ] `CONFIG_PATH` points at a config file with real `chains` and `contracts`.
- [ ] `API_KEY` is set to a long random value if the API is reachable by others.
- [ ] `confirmations` matches the reorg risk of each chain (12 for Ethereum mainnet is a minimum).
- [ ] `pollIntervalMs` respects the RPC provider's rate limits.
- [ ] `LOG_LEVEL=info` (never `debug` in production).
- [ ] RPC URLs are supplied through the environment, never committed.
- [ ] `NODE_ENV=production` so `5xx` bodies stay generic.

## Starting and stopping

```bash
# Compose
docker compose up -d --build
docker compose logs -f app
docker compose down          # keeps the volume
docker compose down -v       # DELETES the database

# Docker directly
docker run -d --name indexer \
  -p 3000:3000 \
  -e DATABASE_URL='postgres://user:pass@host:5432/chain_event_indexer' \
  -e ETH_RPC_URL='https://your-provider/v2/KEY' \
  -e API_KEY='long-random-value' \
  -v "$PWD/config/config.json:/app/config/config.json:ro" \
  chain-event-indexer:local
```

Shutdown handling:

- `SIGTERM`/`SIGINT` trigger a graceful shutdown: the poller stops accepting new
  ticks, in-flight cycles are awaited, the HTTP server closes (fastify drains
  connections), then the pool closes.
- The deadline is 10 s; afterwards the process force-exits with code 1.
- `stop_grace_period: 15s` in compose gives the app enough room before `SIGKILL`.
- The image entrypoint applies migrations and then `exec`s `node dist/index.js`, so
  PID 1 receives the signal directly.

## Migrations

```bash
npm run migrate          # development (tsx)
node dist/db/migrate.js  # production (compiled, also run by the entrypoint)
```

Behaviour:

- `schema_migrations` is created if missing.
- Pending `*.sql` files are applied in lexicographic order.
- Each migration runs inside its own transaction; a failure rolls back and exits
  non-zero.
- Re-running is a no-op (idempotent), which is why the container applies
  migrations on every start.

Rules for authoring migrations: one logical change per file, `IF NOT EXISTS`
guards where possible, never edit an already-applied file (add a new one).

## Health, status and metrics

```bash
curl -s localhost:3000/health           # 200 {"status":"ok","db":"up"} | 503
curl -s localhost:3000/status | jq      # head/target per chain, lag per contract
curl -s localhost:3000/metrics | grep '^indexer_'
```

Recommended alerts:

| Signal | Condition | Meaning |
| --- | --- | --- |
| Up | `/health` ≠ 200 for 2 min | API or database down |
| `lag` in `/status` | `contracts[].lag > 0` for > 15 min | Ingestion is falling behind |
| `rate(indexer_poll_error_total[5m]) > 0` | sustained | RPC or database errors |
| `chains[].lastError != null` | present | Chain-level failure in the last cycle |
| `indexer_events_inserted_total` | flat vs. expected traffic | Possibly a wrong `startBlock`/address |

Suggested scrape interval: 15 s. Labels are bounded by configuration, so cardinality
stays low.

## Logs

pino JSON, one line per event. Useful fields: `reqId`, `chainId`, `address`,
`eventName`, `error`, `durationMs`, `eventsInserted`, `eventsConflicted`.

Redacted automatically: `x-api-key`, `authorization`, cookies, `rpcUrl`,
`DATABASE_URL`, `password`. RPC URLs are additionally masked when formatted for a
message (`maskUrl`).

```bash
docker compose logs -f app | jq 'select(.level >= 40)'   # warnings and errors
LOG_LEVEL=debug npm run dev                              # per-cycle detail
```

## Backup and restore

`event_logs` is reconstructible from the chain plus the config, but re-indexing is
expensive, so back it up like real data.

```bash
# Logical backup
docker exec chain-event-indexer-db \
  pg_dump -U indexer -d chain_event_indexer -Fc -f /tmp/indexer.dump
docker cp chain-event-indexer-db:/tmp/indexer.dump ./indexer.dump

# Restore into a fresh database
docker cp ./indexer.dump chain-event-indexer-db:/tmp/indexer.dump
docker exec chain-event-indexer-db \
  pg_restore -U indexer -d chain_event_indexer --clean --if-exists /tmp/indexer.dump

# Rebuild everything from the chain instead (slow, needs an RPC with history)
docker compose down -v && docker compose up -d --build
```

A rebuild from an empty database needs `startBlock` on every contract to reach
historical data; contracts without `startBlock` intentionally start at the head.

## Scaling

1. **Vertical first** — raise `maxBlockRange` (fewer, larger calls) and
   `pollIntervalMs` (less provider pressure) before adding processes.
2. **Separate workers** — run the API with `POLLER_ENABLED=false` and one or more
   workers with `true`.
3. **Shard by chain** — one worker per chain. Each chain already has its own
   interval, mutex and cursor row.
4. **Read replicas** — point the API at a replica; ingestion stays on the primary.
5. **Queue-backed ingestion** — see `docs/ROADMAP.md`.

Tuning reference:

| Knob | Effect |
| --- | --- |
| `confirmations` ↑ | Safer, more latency |
| `maxBlockRange` ↑ | Fewer calls, higher chance of a provider range error (auto-halved) |
| `pollIntervalMs` ↑ | Less provider load, more latency |
| `maxBatchesPerContract` ↑ | Faster backfill, longer ticks |

## Rollback

The application is stateless apart from the database, so rolling back is a
container/version swap plus (rarely) a schema decision.

```bash
# 1. Revert to the previous image/tag
docker compose down
docker compose up -d --build            # or: docker run ... chain-event-indexer:<previous>

# 2. If the database must be reverted, restore the pre-upgrade dump
docker cp ./indexer.dump chain-event-indexer-db:/tmp/indexer.dump
docker exec chain-event-indexer-db \
  pg_restore -U indexer -d chain_event_indexer --clean --if-exists /tmp/indexer.dump
```

Migration policy that makes rollback safe: **additive only** within a release —
add columns/tables/indexes, never drop or rename. A schema dropped in a release
cannot be restored by rolling the image back.

Rollback checklist:

- [ ] Previous image or commit is known and available.
- [ ] Migration history reviewed: are any changes destructive? If yes, a database
      restore is required.
- [ ] After the swap, `/health` returns 200 and `/status` shows lag returning to 0.
- [ ] Post-mortem note: root cause, detection gap, follow-up action.

## Incident playbook

**Lag keeps growing**

1. `curl /status` → is `targetBlock` moving and `lastIndexedBlock` not? Then
   ingestion is stuck, not the chain.
2. Check logs for `contract ingestion failed` with the error message.
3. If it is a range error, lower `maxBlockRange` (the adaptive shrink already
   handles most cases).
4. If it is provider rate limiting, raise `pollIntervalMs` or move to a dedicated
   RPC plan.

**`/health` returns 503**

1. Verify `DATABASE_URL` and that PostgreSQL accepts connections
   (`pg_isready -U indexer -d chain_event_indexer`).
2. Check connection limits: each replica keeps a pool of up to 10 connections.
3. If the pool is saturated, restart the app; requests have a 30 s timeout.

**`chains[].lastError` is set**

The last cycle could not fetch the head (provider down or throttling). The
poller retries with backoff; no action is required unless the error persists.

**Events stop appearing although `/status` shows no lag**

Check the contract address and the event signature. `topic0` must match the
emitted event exactly: `indexed` is irrelevant, but parameter types are not. A
contract without `startBlock` intentionally skips history — set `startBlock` and
restart to backfill.

**Duplicate rows**

Not possible for the same `(chain_id, tx_hash, log_index)`. If two rows look
identical, they come from two different logs (different `logIndex` or a different
contract entry).

## Docker reference

| Item | Value |
| --- | --- |
| Base image | `node:20-alpine` (multi-stage, `npm ci --omit=dev` runtime) |
| Image tag built by compose | `chain-event-indexer:local` |
| Container port | `3000` |
| User | non-root (`indexer`, uid 10001) |
| Config mount | `./config/…:/app/config/config.json:ro` |
| Healthcheck | `wget -q -O- http://127.0.0.1:3000/health` every 15 s |
| Entrypoint | `node dist/db/migrate.js && exec node dist/index.js` |
| Dev database | `postgres:16-alpine`, port 5432, volume `pgdata` |
| Test database | `postgres:16-alpine`, port **5433**, tmpfs (disposable) |
