# API reference

Base URL: `http://<host>:<port>` (default `http://localhost:3000`).

Interactive documentation is available at `/docs`; the machine-readable OpenAPI
3.0 document is served at `/docs/json`.

## Contents

- [Authentication](#authentication)
- [Error format](#error-format)
- [Status codes](#status-codes)
- [GET /health](#get-health)
- [GET /status](#get-status)
- [GET /metrics](#get-metrics)
- [GET /docs and /docs/json](#get-docs-and-docsjson)
- [GET /events and GET /api/v1/events](#get-events-and-get-apiv1events)
  - [Query parameters](#query-parameters)
  - [Response](#response)
  - [Event item](#event-item)
  - [Pagination](#pagination)
  - [Examples](#examples)
- [Client SDK](#client-sdk)
- [Contract stability](#contract-stability)

---

## Authentication

Authentication is **optional**. If the `API_KEY` environment variable is empty or
unset, every route is public.

When `API_KEY` is set:

| Route | Requires `x-api-key` |
| --- | --- |
| `/health` | no |
| `/status` | no |
| `/metrics` | yes |
| `/docs`, `/docs/json` | yes |
| `/events`, `/api/v1/events` | yes |

Protected prefixes are `/api/v1`, `/events`, `/metrics` and `/docs`. `/health`
and `/status` stay public by design: probes must not need a credential, and the
status payload only exposes chain ids, contract addresses and block heights that
are already public on-chain. See `docs/DECISIONS.md` §5.7.

```bash
curl -s -H 'x-api-key: super-secret' http://localhost:3000/api/v1/events
```
The comparison is timing-safe (both operands are SHA-256 hashed before
`timingSafeEqual`), so a wrong key of a different length leaks no information.

## Error format

Every error response uses the same envelope:

```json
{
  "error": {
    "message": "fromBlock must be less than or equal to toBlock",
    "code": "VALIDATION_ERROR"
  }
}
```

Validation errors may add a machine-readable `details` array:

```json
{
  "error": {
    "message": "Invalid query parameters",
    "code": "VALIDATION_ERROR",
    "details": [{ "path": "limit", "message": "limit must be an integer between 1 and 100" }]
  }
}
```

## Status codes

| Code | Meaning | Codes used |
| --- | --- | --- |
| 200 | Success | — |
| 400 | Validation error | `VALIDATION_ERROR`, `INVALID_CURSOR` |
| 401 | Missing or wrong API key | `UNAUTHORIZED` |
| 404 | Unknown route | `NOT_FOUND` |
| 500 | Unexpected server error | `INTERNAL_ERROR` |
| 503 | Database unavailable | `DB_UNAVAILABLE`, `SERVICE_UNAVAILABLE` |

In production (`NODE_ENV=production`) a `5xx` response always carries the generic
message `Internal server error`; details are written to the structured log with
the request id instead.

---

## GET /health

Public liveness/readiness probe.

```bash
curl -i http://localhost:3000/health
```

```json
{ "status": "ok", "db": "up" }
```

| Status | Body |
| --- | --- |
| `200` | `{"status":"ok","db":"up"}` |
| `503` | `{"status":"error","db":"down","error":{"message":"Database is not reachable","code":"DB_UNAVAILABLE"}}` |

The probe is bounded by a timeout (default 2 s) so a hung database cannot hang the
health endpoint.

## GET /status

Operational view of the indexer.

```bash
curl -s http://localhost:3000/status | jq
```

```json
{
  "uptimeSeconds": 172.5,
  "startedAt": "2024-11-01T09:00:00.000Z",
  "pollerEnabled": true,
  "pollerRunning": true,
  "chains": [
    {
      "chainId": "1",
      "latestBlock": "21000500",
      "targetBlock": "21000488",
      "lastPollAt": "2024-11-01T09:02:52.500Z",
      "lastPollOkAt": "2024-11-01T09:02:52.500Z",
      "lastError": null
    }
  ],
  "contracts": [
    {
      "chainId": "1",
      "address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "eventName": "Transfer",
      "lastIndexedBlock": "21000488",
      "targetBlock": "21000488",
      "lag": "0"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `uptimeSeconds` | Process uptime |
| `pollerEnabled` | Whether the poller was started for this process |
| `pollerRunning` | Whether an interval is currently scheduled |
| `chains[].latestBlock` | Last observed chain head |
| `chains[].targetBlock` | `latestBlock - confirmations` (the highest processable block) |
| `chains[].lastError` | Last chain-level error message, or `null` |
| `contracts[].lastIndexedBlock` | Highest block fully persisted for that contract (from PostgreSQL) |
| `contracts[].lag` | `targetBlock - lastIndexedBlock`, or `null` when the target is unknown |

## GET /metrics

Prometheus exposition format (`text/plain; version=0.0.4`).

| Metric | Type | Labels |
| --- | --- | --- |
| `indexer_poll_success_total` | counter | `chain_id` |
| `indexer_poll_error_total` | counter | `chain_id` |
| `indexer_events_inserted_total` | counter | `chain_id`, `event_name` |
| `indexer_events_conflict_total` | counter | `chain_id`, `event_name` |
| `indexer_last_indexed_block` | gauge | `chain_id`, `contract_address` |
| `indexer_target_block` | gauge | `chain_id` |
| `indexer_poll_duration_seconds` | histogram | `chain_id` |

Labels are bounded by configuration (chain id, contract address, event name).
Transaction hashes and block numbers are never used as labels.

```bash
curl -s http://localhost:3000/metrics | grep '^indexer_'
```

## GET /docs and /docs/json

- `/docs` — Swagger UI (HTML).
- `/docs/json` — the OpenAPI 3.0 document (`info.title` = `Chain Event Indexer API`,
  `info.version` follows `package.json`).

---

## GET /events and GET /api/v1/events

Both paths are served by the **same handler**. `/api/v1/events` is the stable
contract for consumers; `/events` is a convenience alias.

### Query parameters

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `chainId` | decimal string | no | — | `^\d+$` |
| `address` | EVM address | no | — | Case-insensitive; compared against the lowercase stored address |
| `eventName` | string | no | — | 1–200 characters |
| `fromBlock` | decimal string | no | — | Inclusive |
| `toBlock` | decimal string | no | — | Inclusive |
| `txHash` | `0x` + 64 hex | no | — | Case-insensitive |
| `cursor` | opaque string | no | — | `nextCursor` from a previous response |
| `limit` | integer | no | `20` | 1–100 |

Rules:

- Unknown query parameters are rejected with `400` (typo protection).
- `fromBlock > toBlock` is a `400`.
- `limit` outside `1..100` is a `400`.

### Response

```json
{
  "items": [ /* EventItem[] */ ],
  "nextCursor": "eyJ2IjoxLCJpZCI6IjEifQ"
}
```

`nextCursor` is `null` when the current page is the last one.

Ordering is `block_number ASC, log_index ASC, id ASC` — deterministic and stable
for keyset pagination.

### Event item

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Internal row id, always a string |
| `chainId` | string | EVM chain id, always a string |
| `contractAddress` | string | Lowercase contract address |
| `eventName` | string | Name from the configured ABI item |
| `txHash` | string | Transaction hash |
| `logIndex` | string | Log index inside the block |
| `blockNumber` | string | Block number |
| `blockHash` | string | Block hash |
| `transactionIndex` | string | Transaction index inside the block |
| `args` | object | Decoded, JSON-safe arguments; `uint256` values are decimal strings |
| `rawTopics` | string[] | Topics exactly as returned by the RPC |
| `data` | string | Raw log data exactly as returned by the RPC |
| `indexedAt` | string | ISO-8601 timestamp of when the row was written |

Every big number is a string; responses never contain a JSON `bigint`.

### Pagination

The cursor is the base64url encoding of a small versioned envelope holding the
last row `id`. It is opaque: consumers must treat it as a token and echo it back
untouched. A malformed cursor is a `400` with code `INVALID_CURSOR`.

```bash
# page 1
curl -s 'http://localhost:3000/api/v1/events?limit=2'
# page 2 (repeat until nextCursor is null)
curl -s 'http://localhost:3000/api/v1/events?limit=2&cursor=eyJ2IjoxLCJpZCI6IjIifQ'
```

### Examples

```bash
# All Transfer events for one contract on chain 1
curl -s 'http://localhost:3000/api/v1/events?chainId=1&eventName=Transfer&address=0xdac17f958d2ee523a2206206994597c13d831ec7'

# A block window
curl -s 'http://localhost:3000/api/v1/events?fromBlock=21000000&toBlock=21000100'

# A single transaction
curl -s 'http://localhost:3000/api/v1/events?txHash=0x<64 hex chars>'

# Validation error
curl -s 'http://localhost:3000/api/v1/events?limit=1000'
# {"error":{"message":"Invalid query parameters","code":"VALIDATION_ERROR","details":[{"path":"limit","message":"limit must be an integer between 1 and 100"}]}}
```

---

## Client SDK

```ts
import { ChainEventIndexerClient, ChainEventIndexerError } from 'chain-event-indexer/client';

const client = new ChainEventIndexerClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.INDEXER_API_KEY, // optional
  timeoutMs: 15_000,                   // optional, default 15s
});

const page = await client.getEvents({ chainId: '1', limit: 100, cursor: undefined });
const status = await client.getStatus();
const health = await client.getHealth();

try {
  await client.getEvents({ fromBlock: '10', toBlock: '5' });
} catch (error) {
  if (error instanceof ChainEventIndexerError) {
    console.error(error.status, error.code, error.body);
  }
}
```

`ChainEventIndexerError` fields:

| Field | Meaning |
| --- | --- |
| `status` | HTTP status, or `0` when the request never completed |
| `code` | Server error code (`VALIDATION_ERROR`, `UNAUTHORIZED`, …), `TIMEOUT`, or `NETWORK_ERROR` |
| `body` | Parsed response body |
| `isClientError` | `true` for `4xx` |
| `isTransportError` | `true` when `status === 0` |

The SDK uses the global `fetch` and has **no runtime dependencies**.

## Contract stability

- `/api/v1/events` is the versioned, stable endpoint. Breaking changes require a
  new version prefix (`/api/v2/...`); additive fields may appear inside
  `items[]` without a version bump, so consumers should ignore unknown fields.
- `/events` mirrors `/api/v1/events` and exists for convenience.
- `/status` is operational and may gain fields; do not depend on its exact shape
  for business logic.
- Big numbers are always strings — never parse them into JavaScript `number` if
  they can exceed 2^53.
