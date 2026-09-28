# Roadmap

A staged path from this MVP to a multi-chain, horizontally scalable indexer. Each
stage is independently useful and additive: nothing here requires a breaking API
change, because the consumer contract is already versioned
(`/api/v1/events`).

## Stage 0 — the MVP (this repository)

- [x] Config-driven chains/contracts with fail-fast validation
- [x] viem polling with confirmations, chunking, retry and adaptive range shrinking
- [x] Idempotent storage keyed by `(chain_id, tx_hash, log_index)`
- [x] Atomic cursor + rows in one transaction
- [x] Versioned REST API with cursors, filters and JSON-safe numbers
- [x] Optional API key, structured logs, Prometheus metrics
- [x] Docker, compose, CI, unit + integration tests, runbook

## Stage 1 — harden the single-process deployment

- [ ] **Reorg handling**: detect a `blockHash` mismatch for an already indexed
      block and roll the cursor back to the fork point inside a transaction.
      Requires a `blocks`/`checkpoints` table to compare hashes cheaply.
- [ ] **Provider pool**: multiple RPC endpoints per chain with health tracking and
      failover (`chains[].rpcUrls: string[]`).
- [ ] **Per-chain `startBlock` discovery**: use the contract creation block from an
      explorer/RPC where available, instead of a hand-written value.
- [ ] **Retention/partitioning**: monthly partitions for `event_logs` and a
      documented retention policy; keeps vacuum and index size predictable.
- [ ] **Readiness vs liveness**: separate `/health` (process) from `/ready`
      (database + first successful cycle).

## Stage 2 — split the workloads

Goal: scale the API and the ingestion independently.

- [ ] **API replicas**: run with `POLLER_ENABLED=false` behind a load balancer
      (already supported).
- [ ] **Separate poller workers**: one process per chain or per shard of chains,
      still writing to the same database (safe because every write is idempotent).
- [ ] **Advisory locks** (`pg_advisory_lock`) per chain so duplicated workers skip
      rather than duplicate work.
- [ ] **Worker heartbeats** in a `workers` table, surfaced by `/status`, so a dead
      worker is visible.

## Stage 3 — queue-based ingestion

Goal: decouple discovery from fetching and make ingestion replayable.

```
scheduler ──enqueue (chainId, fromBlock, toBlock)──► queue ──► worker pool
                                                              │
                                                    runPollCycle(range)
                                                              ▼
                                                          PostgreSQL
```

- [ ] Introduce a `JobQueue` port with two adapters: in-process (default, used by
      tests) and Redis/BullMQ (or Kafka for a replayable log).
- [ ] Keep `runPollCycle` as the unit of work — it already takes an explicit range,
      so it becomes the consumer with no logic change.
- [ ] Idempotent consumers: the storage layer already guarantees it.
- [ ] Dead-letter queue plus `indexer_queue_depth` / `indexer_job_failures_total`
      metrics.

**When to do this:** when a single poller cannot keep up with the head on one
chain, or when a backfill competes with live traffic. Not before — a queue adds an
operational dependency.

## Stage 4 — caching and read scaling

- [ ] **Read replicas** for the API (`DATABASE_URL` → replica); ingestion stays on
      the primary.
- [ ] **Materialized views** for hot consumer queries (per-address histories,
      daily aggregates, token transfer counts).
- [ ] **Redis cache** for repeated identical queries (short TTL, cache key derived
      from the normalized query), with the cursor preserved.
- [ ] **Sharding by `chain_id`** once one database cannot hold the volume; the
      schema already carries `chain_id` on every row, which makes this a routing
      change rather than a redesign.

## Stage 5 — consumer ergonomics

- [ ] **Webhooks/SSE**: notify consumers when new events matching a filter are
      indexed (never WebSockets inside the request path).
- [ ] **Aggregation endpoints**: `/api/v1/stats` (counts per contract/event/day).
- [ ] **Bulk export**: `GET /api/v1/events/export` streaming NDJSON for warehouse
      loads.
- [ ] **Per-consumer API keys** with scopes and rate limits, plus usage metrics.

## Explicitly not planned

- Wallet/private-key functionality or any write/send transaction capability.
- GraphQL: the REST contract is versioned and the consumers are known.
- Kubernetes/Terraform automation inside this repository; the deployment
  environment owns that.
- A monolithic "everything" indexer (traces, receipts, state). This tool indexes
  **logs**, and stays good at it.

## Known limitations of the MVP

| Limitation | Impact | Workaround today |
| --- | --- | --- |
| No reorg rollback beyond `confirmations` | A deep reorg could leave stale rows | Raise `confirmations` (Stage 1 fixes it properly) |
| One `startBlock` per contract, hand-written | A wrong value means missing/spurious history | Re-check against an explorer; re-index with a corrected value |
| Id-based cursor | A hypothetical past-dated backfill could be missed mid-pagination | Rare by design; revisit if backfill-into-the-past ships |
| Decode failure blocks that contract's chunk | Ingestion pauses for that contract until the ABI/config is fixed | The error is logged with tx hash and log index; the cursor does not move |
| Single RPC endpoint per chain | Provider outage stalls that chain | Raise retry budget / add a fallback endpoint (Stage 1) |
| `event_logs` grows without bound | Long-term storage and vacuum cost | Partitioning + retention (Stage 1) |
| No per-key rate limiting | A noisy consumer can saturate the API | Put a gateway in front |
