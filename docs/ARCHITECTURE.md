# Architecture

## Goals

1. **Correctness first** — an event is either fully persisted with its cursor or
   not persisted at all.
2. **Restart safety** — every piece of progress lives in PostgreSQL.
3. **A stable consumer contract** — the API is versioned and additive.
4. **Additive scaling** — the ingestion engine must be liftable behind a queue
   without changing the API or the schema.

## Module map

```
src/
├── index.ts              process entry (server + poller) and library exports
├── bootstrap.ts          production wiring: env → config → DB → migrations → app
├── app.ts                buildApp(options): Fastify app with injected dependencies
├── types.ts              shared types (config, chain, db, API DTOs)
├── config/
│   ├── schema.ts         zod schemas for the raw JSON file
│   ├── normalize.ts      semantic validation + normalization + contractKey
│   └── load.ts           path resolution, read, interpolate, validate
├── chain/
│   ├── client.ts         viem public clients (one per chain)
│   ├── topic.ts          parseAbiItem + toEventSelector (topic0)
│   ├── decoder.ts        decodeEventLog + BigInt→string conversion
│   ├── fetchLogs.ts      eth_getLogs chunking, retry, adaptive range shrinking
│   ├── ingest.ts         runPollCycle: the ingestion engine
│   ├── poller.ts         per-chain intervals + per-chain mutex + lifecycle
│   └── status.ts         PollerStatusStore (in-memory runtime state)
├── db/
│   ├── client.ts         Pool, Queryable/ClientLike/PoolLike, withTransaction
│   ├── migrate.ts        migration runner + CLI
│   └── repositories/     contracts.ts, events.ts, state.ts
├── server/
│   ├── auth.ts           optional x-api-key hook (timing-safe)
│   ├── errors.ts         AppError, envelopes, error/404 handlers
│   ├── openapi.ts        @fastify/swagger + swagger-ui
│   └── routes/           health.ts, status.ts, metrics.ts, events.ts
├── metrics/metrics.ts    prom-client registry + custom metrics
├── client/index.ts       typed SDK (no runtime dependencies)
└── utils/                env, json, cursor, numbers, retry, mutex, time, logger, errors
```

Dependency direction is strictly downward: `server` and `chain` depend on `db`,
`config` and `utils`; nothing in `utils` imports upward. The client SDK imports
only types, so it can be bundled in a browser-free consumer.

## Dependency injection

```ts
const built = await buildApp({
  config,                 // required
  logger,                 // required
  pool,                   // borrowed when provided, otherwise created from DATABASE_URL
  metrics, status, clients, contracts,   // borrowed when provided
  apiKey, isProduction,
  startPoller,            // default false
});
```

Rules:

- Anything injected is **borrowed**: `close()` only tears down the pool when this
  call created it (`ownsPool`).
- `startPoller` defaults to **false**. Only `bootstrap()`/`index.ts` turn it on,
  which is why tests never spawn background intervals by accident.
- `await app.ready()` runs inside `buildApp`, so `app.inject()` works in tests
  without binding a port.

## Ingestion pipeline

```
                 ┌──────────────── per chain, every pollIntervalMs ────────────────┐
                 │  mutex.tryRunExclusive(chainId)  → skip tick if a cycle is busy  │
                 └───────────────────────────────┬─────────────────────────────────┘
                                                 ▼
                                  latestBlock = client.getBlockNumber()
                                                 ▼
                            targetBlock = latestBlock - confirmations
                                                 ▼
                                     targetBlock < 0 ? skip chain
                                                 ▼
                                   for each contract of that chain
                                                 ▼
        ┌───────────────────── cursor bootstrap (once) ─────────────────────┐
        │ startBlock set    → lastFinalized = startBlock - 1                 │
        │ startBlock absent → lastFinalized = targetBlock (no backfill)      │
        └───────────────────────────────┬────────────────────────────────────┘
                                        ▼
                 fromBlock = max(lastFinalized + 1, 0);  fromBlock > target → skip
                                        ▼
             split [fromBlock, target] into maxBlockRange windows
                                        ▼
        fetchLogs(range) → retry(backoff+jitter) → halve range on range errors
                                        ▼
                 decode each log (viem) → BigInt → decimal string
                                        ▼
                 sort by (block_number, log_index, tx_hash)
                                        ▼
   ┌──────────────────────── BEGIN ────────────────────────┐
   │ INSERT INTO event_logs … ON CONFLICT DO NOTHING        │
   │ UPSERT ingestion_state = rangeEnd                      │
   └──────────────────────── COMMIT ───────────────────────┘
                                        ▼
                    metrics + runtime status updated; next window
```

**Why the cursor and the rows share a transaction:** if the process dies after
`COMMIT`, both are durable and the next cycle resumes after `rangeEnd`. If it dies
before, neither is durable and the next cycle re-fetches the same window — which
is harmless because the insert is idempotent. There is no window in which events
are stored but the cursor is behind (infinite rework) or the cursor is ahead
(silent data loss).

### Idempotency

The natural key of an EVM log is `(chain_id, tx_hash, log_index)`. Inserts use
`INSERT ... ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`, so replaying a
range never duplicates rows and never fails. This also makes it safe to run more
than one poller against the same database.

### Failure model

| Failure | Behaviour |
| --- | --- |
| Transient RPC error (429, 5xx, socket, timeout) | Retried with exponential backoff + full jitter (default 5 attempts, 250 ms base, 10 s ceiling) |
| Invalid-request RPC error (400, `-32602`, …) | **Not** retried — fails fast |
| Range too large | The window is halved and retried from the same cursor, down to a single block |
| Event decode failure | The contract's chunk fails; the cursor stays at the last committed block; other contracts continue |
| Insert failure | The transaction rolls back; the cursor does not move; the next cycle retries |
| Head fetch failure | The chain is skipped for this cycle, the error is recorded in `/status` and metrics |
| Overlapping cycle | The tick is skipped (per-chain mutex) and a warning is logged |
| One contract fails | The remaining contracts on that chain still run |

`maxBatchesPerContract` (default 25 windows per cycle) bounds the work per cycle
so a large backfill cannot monopolise a single tick; the remaining work continues
on the next tick with the same cursor.

### Runtime status vs persisted state

| Question | Source |
| --- | --- |
| What is the chain head? | `PollerStatusStore` (in memory, lost on restart) |
| What has been indexed? | `ingestion_state` in PostgreSQL (survives restart) |
| What is the lag? | Computed in `/status` from both |

`/status` therefore keeps reporting the truth after a restart: only the head
information is empty until the first cycle completes.

## HTTP layer

- **Route table**: `/health`, `/status`, `/metrics`, `/docs`, `/docs/json`,
  `/events`, `/api/v1/events`.
- **Auth**: a single `onRequest` hook protects `/api/v1`, `/events`, `/metrics`
  and `/docs` when `API_KEY` is set; `/health` is always public.
- **Validation**: query parameters are validated with Zod inside the handler so
  that every rejection uses the `{ error: { message, code } }` envelope. The
  route also carries a JSON Schema twin (with `attachValidation: true`) purely so
  that the OpenAPI document lists the parameters.
- **Response schemas** are injected through `@fastify/swagger`'s `transform` hook,
  so they never serialise real responses. That keeps dynamic payloads such as
  decoded `args` intact.
- **Errors**: `createErrorHandler` maps `AppError`, `ZodError` and Fastify errors
  onto the envelope; `5xx` messages are generic in production while the full
  error is logged with the request id.
- **Timeouts**: request timeout 30 s, connection timeout 10 s, DB health probe 2 s.

## Data model

| Table | Purpose | Key |
| --- | --- | --- |
| `contracts` | Registered contracts (from config) | `UNIQUE(chain_id, address, event_signature)` |
| `event_logs` | Decoded events | `UNIQUE(chain_id, tx_hash, log_index)` |
| `ingestion_state` | Per-contract cursor | `contract_id` |
| `schema_migrations` | Applied migrations | `name` |

`event_logs` indexes: `(chain_id, block_number, log_index)`,
`(contract_id, block_number, log_index)`, `(tx_hash)`. All EVM quantities are
`NUMERIC(78,0)` so a full `uint256` is stored without precision loss, which also
makes keyset pagination on `(block_number, log_index, id)` correct in SQL order.

`last_finalized_block = -1` is a valid sentinel meaning "nothing processed yet";
it is what makes `startBlock: 0` expressible without ever querying a negative
block.

## Configuration → startup sequence

```
.env (no override) → logger → config (fail fast) → DB reachable (≤30s)
   → migrations → register contracts → viem clients → Fastify app
   → listen → poller start → SIGINT/SIGTERM handlers
```

Shutdown order is poller → HTTP server → database pool, with a 10 s graceful
deadline before a forced exit.

## Testing strategy

| Level | Rules |
| --- | --- |
| Unit | No network, no database. viem and `fetch` are replaced with fixtures. |
| Integration | Real PostgreSQL, real migrations, real Fastify via `app.inject()`. The poller is never started; `runPollCycle` is driven with a deterministic fake client. |

`tests/integration/helpers.ts` provides `buildTestApp`, `seedEvents`, a
`FakeChainClient` and log factories so ingestion behaviour (confirmations,
`startBlock`, no backfill, range splitting, idempotent replay, failure isolation)
is asserted without touching a network.
