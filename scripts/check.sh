#!/usr/bin/env bash
#
# Full local quality gate.
#
#   bash scripts/check.sh
#
# Runs: lint -> typecheck -> unit tests -> build -> integration tests.
# Integration tests are executed against a disposable PostgreSQL started with
# docker-compose.test.yml and torn down again on exit. When Docker is not
# available the integration step is skipped with an explicit message instead of
# failing the whole check.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="docker-compose.test.yml"
TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://indexer:indexer_password@localhost:5433/chain_event_indexer_test}"
STARTED_DB=0

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

cleanup() {
  if [ "$STARTED_DB" = "1" ]; then
    log "Stopping the test database"
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log "lint"
npm run lint

log "typecheck"
npm run typecheck

log "unit tests"
npm run test:unit

log "build"
npm run build

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "starting the test database"
  if docker compose -f "$COMPOSE_FILE" up -d; then
    STARTED_DB=1
    log "waiting for PostgreSQL to accept connections"
    for _ in $(seq 1 60); do
      if docker compose -f "$COMPOSE_FILE" exec -T postgres-test \
        pg_isready -U indexer -d chain_event_indexer_test >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    log "integration tests"
    DATABASE_URL="$TEST_DATABASE_URL" npm run test:integration
  else
    log "SKIPPED integration tests: the test database could not be started"
  fi
else
  log "SKIPPED integration tests: docker is not available"
fi

log "check complete"
