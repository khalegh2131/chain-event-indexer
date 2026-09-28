# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Pluggable ingestion queue (see `docs/ROADMAP.md`)
- Per-chain worker processes
- Reorg detection with cursor rollback

## [0.1.0] - 2024-11-01

### Added

- Config-driven EVM log indexer (`config/config.example.json`, `CONFIG_PATH`,
  `${ENV_VAR}` interpolation).
- Read-only viem polling pipeline: head discovery, confirmations threshold,
  `maxBlockRange` chunking, adaptive range shrinking, retry with exponential
  backoff and jitter.
- Idempotent event persistence in PostgreSQL keyed by
  `(chain_id, tx_hash, log_index)` with `INSERT ... ON CONFLICT DO NOTHING`.
- Atomic cursor advancement: events and `ingestion_state` commit in the same
  transaction.
- Plain-SQL migration runner (`migrations/0001_init.sql`) with a
  `schema_migrations` ledger and per-migration transactions.
- REST API: `GET /health`, `GET /status`, `GET /metrics`, `GET /docs`,
  `GET /docs/json`, `GET /events` and `GET /api/v1/events`.
- Zod-validated query parameters, opaque base64url cursors, string-only
  big-number responses and JSON-safe event arguments.
- Optional API-key authentication with a timing-safe comparison; `/health`
  stays public.
- Prometheus metrics (`indexer_poll_success_total`, `indexer_poll_error_total`,
  `indexer_events_inserted_total`, `indexer_events_conflict_total`,
  `indexer_last_indexed_block`, `indexer_target_block`,
  `indexer_poll_duration_seconds`).
- Structured pino logging with request ids and secret redaction.
- Typed client SDK for consumers 003 and 9 (`src/client/index.ts`).
- Docker multi-stage image, `docker compose` development stack and a
  disposable test database (`docker-compose.test.yml`, port 5433).
- Vitest unit and integration suites, `scripts/check.sh`, `Makefile` and a
  GitHub Actions workflow that runs lint, typecheck, both test suites, the
  build and a Docker image build.
- Documentation set: `README.md`, `docs/API.md`, `docs/CONFIG.md`,
  `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md`,
  `docs/DECISIONS.md`, `docs/ROADMAP.md`, `docs/GITHUB_PUSH.md`.
