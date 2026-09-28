import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../../src/app';
import { createPollerStatusStore } from '../../src/chain/status';
import type { PoolLike } from '../../src/db/client';
import { createMetrics } from '../../src/metrics/metrics';
import type { ChainClientLike } from '../../src/types';
import {
  buildTestConfig,
  createTestPool,
  testLogger,
  truncateAll,
} from './helpers';

let pool: PoolLike;
const builtApps: BuiltApp[] = [];

beforeAll(async () => {
  pool = createTestPool();
  await pool.query('SELECT 1');
});

afterEach(async () => {
  while (builtApps.length > 0) {
    const built = builtApps.pop();
    if (built) await built.close();
  }
  await truncateAll(pool);
});

afterAll(async () => {
  await pool.end();
});

function brokenPool(): PoolLike {
  const failure = (): never => {
    throw new Error('connection terminated unexpectedly');
  };
  return {
    query: async () => failure(),
    connect: async () => failure(),
    end: async () => undefined,
  } as unknown as PoolLike;
}

function hangingPool(): PoolLike {
  return {
    query: () => new Promise(() => undefined),
    connect: () => new Promise(() => undefined),
    end: async () => undefined,
  } as unknown as PoolLike;
}

async function buildWith(
  dbPool: PoolLike,
  overrides: {
    healthCheckTimeoutMs?: number;
    registerDocs?: boolean;
    isProduction?: boolean;
  } = {},
): Promise<BuiltApp> {
  const built = await buildApp({
    config: buildTestConfig(),
    pool: dbPool,
    logger: testLogger,
    metrics: createMetrics({ collectDefaultMetrics: false }),
    status: createPollerStatusStore(),
    clients: new Map<string, ChainClientLike>(),
    contracts: new Map(),
    apiKey: null,
    isProduction: overrides.isProduction ?? false,
    startPoller: false,
    registerDocs: overrides.registerDocs ?? false,
    healthCheckTimeoutMs: overrides.healthCheckTimeoutMs,
  });
  builtApps.push(built);
  return built;
}

describe('GET /health', () => {
  it('returns 200 with the documented body when the database is reachable', async () => {
    const built = await buildWith(pool);

    const response = await built.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string; db: string }>()).toEqual({ status: 'ok', db: 'up' });
  });

  it('returns 503 with an error envelope when the database is unavailable', async () => {
    const built = await buildWith(brokenPool());

    const response = await built.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    const body = response.json<{
      status: string;
      db: string;
      error: { message: string; code: string };
    }>();
    expect(body.status).toBe('error');
    expect(body.db).toBe('down');
    expect(body.error.code).toBe('DB_UNAVAILABLE');
  });

  it('returns 503 when the database probe hangs past the configured timeout', async () => {
    const built = await buildWith(hangingPool(), { healthCheckTimeoutMs: 100 });

    const startedAt = Date.now();
    const response = await built.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('does not leak a stack trace through the error envelope', async () => {
    const built = await buildWith(brokenPool());

    const response = await built.app.inject({ method: 'GET', url: '/health' });

    expect(response.body).not.toContain('at ');
    expect(response.body).not.toContain('.ts:');
  });
});

describe('error envelope for database level failures', () => {
  it('hides the underlying error behind a generic message in production', async () => {
    const built = await buildWith(brokenPool(), { isProduction: true });

    const response = await built.app.inject({ method: 'GET', url: '/status' });

    expect(response.statusCode).toBe(500);
    const body = response.json<{ error: { message: string; code: string } }>();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
    expect(response.body).not.toContain('connection terminated');
  });

  it('surfaces the underlying message outside production', async () => {
    const built = await buildWith(brokenPool(), { isProduction: false });

    const response = await built.app.inject({ method: 'GET', url: '/status' });

    expect(response.statusCode).toBe(500);
    const body = response.json<{ error: { message: string; code: string } }>();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toContain('connection terminated unexpectedly');
  });

  it('returns 400 (not 500) for a bad request even when the database is down', async () => {
    const built = await buildWith(brokenPool());

    const response = await built.app.inject({ method: 'GET', url: '/events?limit=999' });

    expect(response.statusCode).toBe(400);
  });
});
