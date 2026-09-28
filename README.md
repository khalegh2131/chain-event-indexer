# chain-event-indexer

A config-driven EVM chain event indexer MVP: it polls contract logs over HTTP
with [viem](https://viem.sh), decodes them, stores them idempotently in
PostgreSQL, and serves a stable, versioned REST API.

> Maintained by **Khaleq Salehi** — [khaleq.sa@gmail.com](mailto:khaleq.sa@gmail.com) ·
> Phone / WhatsApp / Telegram: **+98 912 014 3697** · [wa.me/989120143697](https://wa.me/989120143697)


---

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [Architecture summary](#architecture-summary)
- [Quickstart with Docker](#quickstart-with-docker)
- [Local development](#local-development)
- [Tests](#tests)
- [API examples](#api-examples)
- [Configuration examples](#configuration-examples)
- [Troubleshooting](#troubleshooting)
- [Future scaling path](#future-scaling-path)
- [Contact](#contact)
- [Documentation](#documentation)
- [License](#license)

---

## Overview

The indexer is a read-only pipeline. It never holds a private key and never sends
a transaction.

```
config.json ──► config loader ──► poller (per chain) ──► eth_getLogs (viem)
                                        │
                                        ▼
                              decode + normalize to JSON
                                        │
                                        ▼
                   INSERT ... ON CONFLICT DO NOTHING  ──►  PostgreSQL
                   UPDATE ingestion_state (same transaction)
                                        │
                                        ▼
                         Fastify REST API  /api/v1/events
```

Key guarantees:

| Guarantee | How it is achieved |
| --- | --- |
| Idempotent ingestion | Unique key `(chain_id, tx_hash, log_index)` + `ON CONFLICT DO NOTHING` |
| Crash-safe cursor | `ingestion_state` is updated in the **same transaction** as the event rows |
| No unconfirmed data | `targetBlock = latestBlock - confirmations` |
| No huge responses | All big numbers are returned as strings |
| Stable consumer contract | `GET /api/v1/events`, aliased by `GET /events` |
| Safe restarts | Migrations are idempotent; the cursor is persisted in the database |
| Additive scaling | Poller, ingestion engine and HTTP layer are separate modules |

## Features

- **Configuration driven** — chains and contracts come from JSON; `${ENV_VAR}`
  placeholders are interpolated and validated at startup.
- **Fail-fast validation** — addresses are checked with `viem.isAddress`, event
  signatures are parsed with `viem.parseAbiItem`, `topic0` is derived, duplicate
  contracts and undeclared chains are rejected, and every problem is reported at
  once.
- **Resilient RPC handling** — exponential backoff with full jitter, transient
  error classification (429/5xx/network), automatic `eth_getLogs` range halving
  when a provider rejects the range, and a per-chain mutex that skips overlapping
  cycles instead of queueing them.
- **Exactly-once semantics at the storage boundary** — a contract failure never
  loses data because the cursor only moves with the rows it covers.
- **Observability** — structured pino logs with request ids and secret
  redaction, `GET /status` with per-contract lag, and Prometheus metrics.
- **Security by default** — optional API key using a timing-safe comparison, no
  secrets in logs, no stack traces in production responses.
- **Developer experience** — typed client SDK, unit tests that need no network or
  database, integration tests against a disposable Docker PostgreSQL, `Makefile`
  and one-command quality gate.

## Architecture summary

| Layer | Modules | Responsibility |
| --- | --- | --- |
| Config | `src/config/*` | Path resolution, JSON parsing, env interpolation, shape validation, semantic normalization |
| Chain | `src/chain/*` | viem clients, topic derivation, log fetching, decoding, ingestion engine, poller, runtime status |
| Storage | `src/db/*` | Pool + transactions, migration runner, repositories (contracts, events, state) |
| HTTP | `src/server/*`, `src/app.ts` | Fastify app builder, auth hook, error envelope, OpenAPI, routes |
| SDK | `src/client/index.ts` | Typed client for consumers 003 and 9 (no runtime dependencies) |
| Cross-cutting | `src/utils/*`, `src/metrics/*` | Retry, mutex, cursors, JSON safety, logging, metrics |

`buildApp(options)` performs dependency injection: whatever is passed in is
borrowed and never closed, which is what lets the integration suite build the
real API against a real database with the poller disabled.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full detail, including
the ingestion state machine.

## Quickstart with Docker

```bash
git clone https://github.com/khalegh2131/chain-event-indexer.git
cd chain-event-indexer

# 1. Provide the RPC endpoint (and optionally an API key)
cp .env.example .env
#   ETH_RPC_URL=https://ethereum-rpc.publicnode.com
#   API_KEY=                      # leave empty to disable auth

# 2. Start PostgreSQL + the indexer
docker compose up -d --build

# 3. Confirm it is alive
curl -s http://localhost:3000/health
# {"status":"ok","db":"up"}

# 4. Read indexed events (Transfer events of the example ERC-20 contract)
curl -s 'http://localhost:3000/api/v1/events?limit=2'

# 5. Watch the ingestion progress
curl -s http://localhost:3000/status

# 6. Shut everything down
docker compose down          # add -v to also delete the database volume
```

Useful compose knobs (all optional):

```bash
ETH_RPC_URL=https://your-provider/v2/KEY docker compose up -d
API_KEY=super-secret docker compose up -d
CONFIG_FILE=config/config.json docker compose up -d   # mount your own config file
docker compose logs -f app
```

The container applies migrations on start (`node dist/db/migrate.js`) and then
runs the server. The image tag is `chain-event-indexer:local`.

## Local development

```bash
# Node.js >= 20
node --version

npm ci

# 1. Start a PostgreSQL for development (port 5432)
docker compose up -d postgres

# 2. Create your config file (config/config.json is git-ignored)
cp config/config.example.json config/config.json
cp .env.example .env
#   DATABASE_URL=postgres://indexer:indexer_password@localhost:5432/chain_event_indexer

# 3. Apply migrations
npm run migrate

# 4. Run with hot reload
npm run dev
```

Quality commands:

```bash
npm run lint        # eslint . --max-warnings=0
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.build.json  ->  dist/
npm start           # node dist/index.js
npm run format      # prettier --write
```

Or use the `Makefile`:

```bash
make install dev lint typecheck test build migrate up down logs check
```

## Tests

| Command | What it runs | Requirements |
| --- | --- | --- |
| `npm run test:unit` (or `npm test`) | Unit tests | none — no network, no database |
| `npm run test:integration` | Integration tests | PostgreSQL |
| `npm run test:all` | Unit + integration | PostgreSQL |
| `bash scripts/check.sh` | lint + typecheck + unit + build + integration | Docker (for the DB) |

Integration tests use a dedicated database on port **5433**:

```bash
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgres://indexer:indexer_password@localhost:5433/chain_event_indexer_test \
  npm run test:integration
docker compose -f docker-compose.test.yml down -v
```

Coverage highlights:

- **Unit** — config validation and defaults, env interpolation, address
  normalization, `topic0` derivation, BigInt JSON serialization, cursor
  encode/decode, retry classification and backoff, mutex overlap prevention,
  event decoding with viem-compatible fixtures, `eth_getLogs` chunking and range
  shrinking, and the client SDK with a mocked `fetch`.
- **Integration** — migrations run twice, table/index/constraint checks, contract
  registration, idempotent duplicate upserts, batch splitting, every
  `/events` filter and pagination path, `400` validation paths, API key enforced
  and disabled, `/health`, `/status`, `/metrics`, `/docs/json`, and full
  `runPollCycle` behaviour (confirmations, `startBlock`, no backfill, cursor
  monotonicity, failure isolation, retry, poller orchestration).

## API examples

```bash
# Health (always public)
curl -s http://localhost:3000/health

# Status: head/target per chain and lag per contract
curl -s http://localhost:3000/status | jq

# Prometheus metrics
curl -s http://localhost:3000/metrics | grep indexer_

# OpenAPI document / Swagger UI
curl -s http://localhost:3000/docs/json | jq '.info'
open http://localhost:3000/docs
```

### `GET /api/v1/events`

| Parameter | Type | Notes |
| --- | --- | --- |
| `chainId` | decimal string | e.g. `1` |
| `address` | EVM address | case-insensitive, normalized to lowercase |
| `eventName` | string | e.g. `Transfer` |
| `fromBlock` | decimal string | inclusive |
| `toBlock` | decimal string | inclusive; `fromBlock > toBlock` is a `400` |
| `txHash` | `0x` + 64 hex | case-insensitive |
| `cursor` | opaque string | value of `nextCursor` from the previous page |
| `limit` | integer 1–100 | default `20` |

```bash
curl -s 'http://localhost:3000/api/v1/events?chainId=1&eventName=Transfer&limit=2'
```

```json
{
  "items": [
    {
      "id": "1",
      "chainId": "1",
      "contractAddress": "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "eventName": "Transfer",
      "txHash": "0x…",
      "logIndex": "42",
      "blockNumber": "21000001",
      "blockHash": "0x…",
      "transactionIndex": "7",
      "args": { "from": "0x…", "to": "0x…", "value": "1000000" },
      "rawTopics": ["0xddf2…", "0x…", "0x…"],
      "data": "0x…",
      "indexedAt": "2024-11-01T09:15:22.104Z"
    }
  ],
  "nextCursor": "eyJ2IjoxLCJpZCI6IjEifQ"
}
```

Pagination:

```bash
curl -s 'http://localhost:3000/api/v1/events?limit=2' | jq -r .nextCursor
curl -s 'http://localhost:3000/api/v1/events?limit=2&cursor=eyJ2IjoxLCJpZCI6IjEifQ'
```

With an API key configured, add `-H 'x-api-key: <key>'` to every protected
request. `/health` never requires it.

### Client SDK

```ts
import { ChainEventIndexerClient } from 'chain-event-indexer/client';

const client = new ChainEventIndexerClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.INDEXER_API_KEY,
});

const page = await client.getEvents({ chainId: '1', eventName: 'Transfer', limit: 50 });
for (const event of page.items) {
  console.log(event.blockNumber, event.args);
}

const health = await client.getHealth();
const status = await client.getStatus();
```

Errors are typed: `ChainEventIndexerError` exposes `status`, `code`, `body`,
`isClientError` and `isTransportError`.

## Configuration examples

```json
{
  "chains": [
    {
      "chainId": 1,
      "rpcUrl": "${ETH_RPC_URL}",
      "confirmations": 12,
      "pollIntervalMs": 10000,
      "maxBlockRange": 2000
    }
  ],
  "contracts": [
    {
      "chainId": 1,
      "address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "eventName": "Transfer",
      "eventSignature": "event Transfer(address indexed from, address indexed to, uint256 value)",
      "startBlock": "21000000"
    }
  ]
}
```

| Contract field | Meaning |
| --- | --- |
| `startBlock` present | Backfill from that block (cursor starts at `startBlock - 1`) |
| `startBlock` omitted | Start at the current finalized head, no backfill |

Environment variables (`CONFIG_PATH`, `DATABASE_URL`, `API_KEY`, `PORT`,
`LOG_LEVEL`, `POLLER_ENABLED`, `HOST`, `ENV_FILE`, `MIGRATIONS_DIR`) are
documented in [`docs/CONFIG.md`](docs/CONFIG.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Config file not found at …` | `config/config.json` missing | `cp config/config.example.json config/config.json` or set `CONFIG_PATH` |
| `Missing environment variable "ETH_RPC_URL"` | `${VAR}` placeholder without a value | Export the variable or set it in `.env` |
| `Database was not reachable within 30000ms` | PostgreSQL not up / wrong `DATABASE_URL` | `docker compose up -d postgres`, check the URL, then restart the app |
| `invalid params` in the logs | Provider rejected the request shape | Check `maxBlockRange`; the indexer auto-halves the range for range errors but not for malformed filters |
| `/health` returns `503` | Database unreachable | Check the container and `DATABASE_URL` |
| Events stay empty | Head has not passed `confirmations`, or `startBlock` is in the future | Check `/status` (`latestBlock`, `targetBlock`) and lower `confirmations` for a test |
| `401 Unauthorized` | `API_KEY` is set but the header is missing | Send `x-api-key` (not needed for `/health`) |
| `429` / rate-limit bursts | Provider throttling | Increase `pollIntervalMs`, use a dedicated RPC plan, or lower `maxBlockRange` |
| `address already in use` on the test DB | Another PostgreSQL on 5433 | `docker compose -f docker-compose.test.yml down -v` then retry |

Set `LOG_LEVEL=debug` for per-cycle detail.

## Future scaling path

The MVP is intentionally small but shaped for growth. In order of increasing
effort:

1. **Queue-based ingestion** — replace the direct `runPollCycle` call with a
   producer that enqueues `(chainId, fromBlock, toBlock)` jobs; the ingestion
   engine becomes the consumer. The database contract does not change.
2. **Separate poller workers** — run `POLLER_ENABLED=false` on the API replicas
   and `true` on dedicated workers. The unique constraint already makes
   concurrent writers safe.
3. **Per-chain workers** — shard by `chainId` (the poller is already
   per-chain isolated with its own mutex and interval).
4. **Redis/Kafka** — add only when a queue is actually a bottleneck; Redis for
   dedupe/locks and Kafka for replayable streams.
5. **Read replicas** — point the API at a replica; ingestion stays on the primary.
6. **Caching / materialized views** — for hot consumer queries (per-address
   histories, aggregates) instead of scanning `event_logs`.
7. **Cursor-based public API** — already in place, which is a prerequisite for
   keyset pagination at scale.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for a concrete, staged plan.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/API.md`](docs/API.md) | Endpoint reference, filters, pagination, error codes, SDK |
| [`docs/CONFIG.md`](docs/CONFIG.md) | Config file and environment variables |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Modules, data flow, ingestion state machine, failure model |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Runbook: deploy, migrate, monitor, backup, rollback |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, API key handling, secret hygiene |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every resolved ambiguity and the reasoning behind it |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Scaling and productionization plan |
| [`docs/GITHUB_PUSH.md`](docs/GITHUB_PUSH.md) | How to push this repository to GitHub |

## Contact

Questions, integrations, or a bug report? Reach the maintainer directly:

| Channel | Detail |
| --- | --- |
| Name | **Khaleq Salehi** |
| Email | [khaleq.sa@gmail.com](mailto:khaleq.sa@gmail.com) |
| Phone · WhatsApp · Telegram | **+98 912 014 3697** |
| WhatsApp (direct link) | [wa.me/989120143697](https://wa.me/989120143697) |

Typical response time is within one working day. For anything security related,
please follow [`docs/SECURITY.md`](docs/SECURITY.md) instead of opening a public
issue.

## License

[MIT](LICENSE) © Khaleq Salehi
