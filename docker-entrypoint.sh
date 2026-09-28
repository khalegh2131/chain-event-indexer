#!/bin/sh
#
# Container entrypoint.
#
# 1. Apply pending SQL migrations (idempotent).
# 2. Start the API server and the poller.
#
# `exec` is used for the final command so PID 1 receives SIGTERM/SIGINT directly
# and the graceful shutdown path in src/bootstrap.ts can run.
#
set -e

echo "[entrypoint] applying migrations"
node dist/db/migrate.js

echo "[entrypoint] starting chain-event-indexer"
exec node dist/index.js
