# Decisions

This file records every decision that was not fully specified, plus the trade-offs
that produced it. The guiding rule was: **when a detail is missing, choose the
safest production-ready default and document it here.**

## 1. Resolved ambiguities from the original brief

### 1.1 Database password

The source brief contained a truncated password (`indexe…word`). A concrete local
default is used everywhere: **`indexer_password`**.

It is a development default for the bundled compose stack, not a secret; the
production image never bakes it in and `DATABASE_URL` is always supplied by the
environment.

### 1.2 `.env.example` entry

The brief listed `*** POLLER_ENABLED=true`. That is emitted as the normal entry
`POLLER_ENABLED=true`.

### 1.3 Workspace root

The brief says "create all files inside a folder named `chain-event-indexer`" and
the repository root is already named `chain-event-indexer`, so files live at that
root and no extra nesting is created.

### 1.4 Language

Code, comments and documentation are in English — the conventional language for a
reusable open-source primitive.

### 1.5 Lint/format tooling

ESLint (flat config, `typescript-eslint` recommended, `--max-warnings=0`) plus
Prettier for formatting are added. Prettier is *not* wired into ESLint, so
`npm run lint` never fails because of a formatting disagreement; `npm run format`
handles that separately.

### 1.6 Docker image tag

CI and local builds tag the image `chain-event-indexer:local` (`:ci` in the
GitHub workflow) so a build never overwrites an unrelated image.

## 2. Configuration

### 2.1 `eventName` must match the signature

`eventName` is stored in `event_logs`, so a mismatch against the ABI item's name
would silently produce inconsistent data. It is therefore a **config error**
rather than something that is silently corrected.

### 2.2 Duplicate detection keys on `topic0`

Two config entries can have the same `chainId + address` but differently
formatted signatures. Detecting duplicates on the derived `topic0` (rather than
the raw signature text) catches both the literal and the semantic duplicate.

Note: `indexed` is not part of `topic0`, so ERC-20 and ERC-721 `Transfer` share a
topic. Decoding always uses the configured ABI, and the database identity
includes the address, so this is safe — but it is worth knowing when reading logs.

### 2.3 Strict schemas

The config file, each chain and each contract are `.strict()`: unknown keys are a
startup error. A typo such as `confirmationss` therefore fails loudly instead of
silently using the default.

### 2.4 `startBlock` is preserved on re-registration

`contracts.start_block` uses `COALESCE(EXCLUDED.start_block, contracts.start_block)`,
so removing `startBlock` from the config does not wipe the historical origin of an
already-registered contract.

### 2.5 `.env` never overrides the real environment

`ENV_FILE` (default `./.env`) is loaded before interpolation, but only for
variables that are not already defined. Container/platform environment always
wins.

### 2.6 No `dotenv` dependency

A ~30-line parser in `src/utils/env.ts` covers `KEY=VALUE`, comments, quotes and
`export ` prefixes. This avoids a dependency for something this small and keeps
the install surface minimal.

## 3. Storage

### 3.1 No ORM

Plain parameterized SQL only. All EVM quantities are `NUMERIC(78,0)`, which keeps
`uint256` exact and makes `ORDER BY block_number` correct in SQL rather than in
JavaScript.

### 3.2 Cursor and rows share one transaction

Discussed in `docs/ARCHITECTURE.md`. This is the core correctness decision:
`INSERT ... ON CONFLICT DO NOTHING` and `UPSERT ingestion_state` commit together,
so a crash can only cause harmless rework, never data loss or skipped ranges.

### 3.3 `last_finalized_block = -1` sentinel

A `CHECK (last_finalized_block >= 0)` constraint was intentionally **not** added:
`-1` means "nothing processed yet" and is what makes `startBlock: 0` correct. The
first query is always clamped to block `0` or higher, so a negative `fromBlock` is
never sent to a provider.

### 3.4 Monotonic cursor

`upsertIngestionState` uses `GREATEST(existing, new)`. Even if two cycles were ever
to overlap (for example two replicas with `POLLER_ENABLED=true`), progress cannot
regress.

### 3.5 `ON CONFLICT DO NOTHING` (not `DO UPDATE`)

A finalized log is immutable, so an update is meaningless. `DO NOTHING` also makes
intra-statement duplicates in one batch safe.

### 3.6 Batches of 500 rows

11 bind parameters per row keeps a batch far below PostgreSQL's 65535-parameter
limit, while 500 rows amortises the round trip.

### 3.7 Id-based cursor

The brief explicitly requires an opaque cursor derived from an internal key such
as `id`. The cursor is the base64url encoding of `{"v":1,"id":"<row id>"}`, with a
canonical-encoding check on decode so garbage is rejected rather than silently
mis-parsed.

Trade-off: because the ordering key is `(block_number, log_index, id)` but the
cursor filters on `id`, a row inserted *later* with a *lower* block number (for
example a deliberate backfill) could be missed by an in-flight pagination walk.
Normal operation cannot produce that: the indexer only moves forward, and
re-indexing re-inserts the same `(chain_id, tx_hash, log_index)` rows, which
conflict and are ignored. Revisit if a "backfill into the past" feature is added.

## 4. Ingestion behaviour

### 4.1 Per-cycle batch budget

`maxBatchesPerContract` defaults to 25 windows per cycle. Without a bound, a
several-million-block backfill would occupy one tick for a very long time and
delay head tracking. The cursor makes resuming free.

### 4.2 Range-too-large detection is heuristic

There is no standard error code for "your `eth_getLogs` range is too wide".
Providers use `-32005`, `-32007`, messages such as `query returned more than
10000 results`, `block range is too wide`, `response size exceeded`, and others.
`isRangeTooLargeError` matches a curated list of codes and message patterns; on a
match the window is halved (down to one block) and the same cursor is retried.

Providers whose wording is not covered will surface as ordinary errors, which is
the safe failure mode: the cursor does not move and the error is visible.

### 4.3 Configured `maxBlockRange` is an upper bound

Because the window can shrink adaptively, `effectiveMaxRange` is not the configured
value. `maxBlockRange` is a tuning knob, not a contract.

### 4.4 Decode failures fail the contract's chunk

A log that cannot be decoded against the configured ABI is treated as a real
error: the chunk's transaction rolls back and the cursor does not advance. This is
intentional — silently skipping an event would create an invisible hole in the
data. The error is logged with the transaction hash and log index.

### 4.5 Logs are stored raw

`raw_topics` and `data` are persisted exactly as the RPC returned them (no
lowercasing) so they remain verifiable against the chain. Only the `txHash` filter
is case-insensitive, implemented as `LOWER(e.tx_hash) = $n` on the query side.

### 4.6 Confirmations, not finality

`confirmations` is a heuristic depth (default 12). Reorg handling beyond that depth
is out of scope for the MVP and is listed in `docs/ROADMAP.md`.

## 5. HTTP / API

### 5.1 Unknown query parameters are a 400

`eventsQuerySchema` is `.strict()`. `?eventname=Transfer` (a typo) would otherwise
return unfiltered data, which is worse than an explicit error. Consumers that add
cache-busting parameters should use a header instead.

### 5.2 Zod validates; JSON Schema documents

Query validation runs through Zod in the handler, so every rejection produces the
documented `{ error: { message, code } }` envelope. The route also carries a JSON
Schema twin with `attachValidation: true` so Fastify records (but does not enforce)
its own opinion, purely to populate the OpenAPI parameters list.

### 5.3 Response schemas are documentation-only

They are injected through `@fastify/swagger`'s `transform` hook rather than declared
in the route, so Fastify never runs `fast-json-stringify` over real responses.
Dynamic payloads (decoded `args`, `rawTopics`) therefore cannot be silently
stripped or coerced.

### 5.4 `/events` and `/api/v1/events` share one handler

Both paths are registered with the same function; only the OpenAPI summary differs.

### 5.5 Health body

`{ "status": "ok", "db": "up" }` on success, exactly as specified. On failure the
same envelope as every other error is used, with `status`/`db` fields added for
human debugging.

### 5.6 `/status` keeps its own shape

`/status` is operational: it may gain fields, and its numbers are strings for
consistency with `/events`. It is documented as non-contractual for business
logic.

### 5.7 `/status` is intentionally public

The brief lists the protected surfaces as `/api/v1`, `/events`, `/metrics` and
`/docs`. `/status` is therefore **not** behind the API key, next to `/health`.

Reasoning: liveness/readiness probes and dashboards must work without a
credential, and `/status` only exposes chain ids, contract addresses, block
heights and lag — all of which are public on-chain data. It is documented as
non-contractual for business logic.

If an installation needs `/status` protected, add `/status` to
`PROTECTED_PREFIXES` in `src/server/auth.ts`; the auth hook is the single place
that decides this.

### 5.8 Unknown query parameters really are rejected

Fastify's AJV defaults to `removeAdditional: true`, which silently deletes
properties that are not in a route schema — that would have made
`?unknown=1` return unfiltered data. `removeAdditional` is disabled in
`buildApp`, so Zod `.strict()` sees the extra key and answers `400`.

### 5.9 Health probe has its own timeout

`checkDatabase` wraps `SELECT 1` in `withTimeout` (2 s default). A hung database
must not hang the probe, because orchestrators depend on a timely answer.

### 5.10 Deprecated Fastify options avoided

Fastify 5.12 emits `FSTDEP023`/`FSTDEP024` for the top-level
`disableRequestLogging` and `requestIdLogLabel` options (removed in Fastify 6,
replaced by `logController`, which is not yet present in the 5.x type
 definitions). Neither is set: the defaults already match this service (`reqId` as
the request-id log label, request logging on), so production logs stay free of
deprecation noise. `requestIdHeader: 'x-request-id'` is still honoured, so a
caller-supplied request id flows into every log line.

### 5.11 Prometheus gauge values are numbers

`prom-client` v15 requires a `number` for `Gauge.set`. Block heights are converted
with `Number(value)`; Prometheus samples are float64 anyway, so exactness beyond
2^53 was never available. Real block heights are far below that.

## 6. Process lifecycle

### 6.1 `buildApp` does not start the poller by default

`startPoller` (alias `pollerEnabled`) defaults to **false**; `bootstrap()` enables
it from `POLLER_ENABLED`. Without this, constructing the app in a test would start
background intervals.

### 6.2 Shutdown order

Poller → HTTP server → database pool, with a 10 s deadline and a forced `exit(1)`
afterwards. Stopping the poller first guarantees no query is issued against a
closed pool.

### 6.3 Startup fails fast

Bad config or an unreachable database (after 30 s of retries) exits non-zero rather
than serving a broken API. In the container, migrations run before the server
starts.

### 6.4 `index.ts` is both entry point and library

`main()` runs only under `require.main === module`, so importing the package does
not start a server, while `package.json` can still point `main` at
`dist/index.js` and expose `buildApp`, `bootstrap`, `createPoller` and the SDK.

## 7. Tests

### 7.1 Integration tests never touch the network

`runPollCycle` is exported and driven with `FakeChainClient`, whose `getLogs`
filters by address, topic and block range exactly like a real provider. This makes
confirmations, backfill and failure isolation deterministic.

### 7.2 Single-fork, non-parallel integration run

`fileParallelism: false` plus `singleFork: true` keeps the shared test database
free of cross-file truncation races.

### 7.3 Migrations run in `globalSetup`

The schema is applied once per integration run; individual tests only truncate
tables.

### 7.4 The test database is disposable

`docker-compose.test.yml` uses port `5433` and a `tmpfs` volume, so the test data
never touches the development database and every restart is clean.

## 8. Things explicitly out of scope

- Private keys, signing, and any write/send RPC method.
- GraphQL, WebSockets, frontend frameworks.
- Kubernetes, Terraform, cloud deployment automation.
- Paid services.
- Reorg rollback, queue-based ingestion and per-chain worker processes (planned in
  `docs/ROADMAP.md`).
