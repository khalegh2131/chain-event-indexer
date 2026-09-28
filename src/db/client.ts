import { Pool } from 'pg';
import { sleep, withTimeout } from '../utils/time';
import { describeError } from '../utils/errors';
import type { Logger } from 'pino';

/**
 * Database client, transactions and readiness helpers.
 *
 * The repositories depend on the structural `Queryable`/`PoolLike` interfaces
 * instead of `pg.Pool` directly so tests can inject lightweight fakes.
 */

export interface QueryResultLike<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResultLike<R>>;
}

export interface ClientLike extends Queryable {
  release(): void;
}

export interface PoolLike extends Queryable {
  connect(): Promise<ClientLike>;
  end(): Promise<void>;
}

export interface DbClientOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  applicationName?: string;
}

export function createDbClient(options: DbClientOptions): PoolLike {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: options.applicationName ?? 'chain-event-indexer',
  });
  // Idle clients can fail asynchronously; without a listener pg would throw an
  // unhandled 'error' event and take the process down.
  pool.on('error', () => {
    // Intentionally swallowed: individual queries surface their own errors.
  });
  return pool as unknown as PoolLike;
}

/** Runs `fn` inside a single transaction, rolling back on any failure. */
export async function withTransaction<T>(
  pool: PoolLike,
  fn: (client: ClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Cheap liveness probe used by `/health`. */
export async function checkDatabase(db: Queryable, timeoutMs = 2000): Promise<boolean> {
  try {
    const result = await withTimeout(
      db.query<{ ok: number }>('SELECT 1 AS ok'),
      timeoutMs,
      `Database health check timed out after ${timeoutMs}ms`,
    );
    return Array.isArray(result.rows);
  } catch {
    return false;
  }
}

export interface WaitForDatabaseOptions {
  timeoutMs?: number;
  intervalMs?: number;
  logger?: Logger;
}

/**
 * Blocks until PostgreSQL answers or the deadline passes.
 * Startup fails fast (30s by default) instead of serving a broken API.
 */
export async function waitForDatabase(
  pool: PoolLike,
  options: WaitForDatabaseOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    attempt += 1;
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      options.logger?.warn(
        { attempt, error: describeError(error) },
        'database not ready yet, retrying',
      );
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `Database was not reachable within ${timeoutMs}ms (${attempt} attempts): ${describeError(lastError)}`,
  );
}

/** Closes the pool, ignoring errors raised during shutdown. */
export async function closePool(pool: PoolLike | undefined): Promise<void> {
  if (!pool) return;
  try {
    await pool.end();
  } catch {
    // Shutdown is best-effort; the process is going away anyway.
  }
}
