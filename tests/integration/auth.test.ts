import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../../src/app';
import { isProtectedPath, normalizePath, safeCompare } from '../../src/server/auth';
import type { PoolLike } from '../../src/db/client';
import { buildTestApp, createTestPool, truncateAll } from './helpers';

const API_KEY = 'test-api-key-0123456789';

let pool: PoolLike;
let app: BuiltApp | null = null;

beforeAll(async () => {
  pool = createTestPool();
  await pool.query('SELECT 1');
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  await truncateAll(pool);
});

afterAll(async () => {
  await pool.end();
});

async function startApp(apiKey: string | null): Promise<BuiltApp> {
  const built = await buildTestApp({ pool, apiKey });
  app = built.built;
  return app;
}

describe('auth path matching', () => {
  it('normalizes query strings and trailing slashes', () => {
    expect(normalizePath('/events?limit=1')).toBe('/events');
    expect(normalizePath('/events/')).toBe('/events');
    expect(normalizePath('')).toBe('/');
  });

  it('protects the documented prefixes, keeps /health and /status public', () => {
    expect(isProtectedPath('/health')).toBe(false);
    expect(isProtectedPath('/health?verbose=1')).toBe(false);
    expect(isProtectedPath('/status')).toBe(false);
    expect(isProtectedPath('/events')).toBe(true);
    expect(isProtectedPath('/api/v1/events')).toBe(true);
    expect(isProtectedPath('/metrics')).toBe(true);
    expect(isProtectedPath('/docs')).toBe(true);
    expect(isProtectedPath('/docs/json')).toBe(true);
  });

  it('compares keys safely regardless of length', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abcd')).toBe(false);
    expect(safeCompare('', 'abc')).toBe(false);
  });
});

describe('API key authentication', () => {
  const protectedRoutes = ['/events', '/api/v1/events', '/metrics', '/docs', '/docs/json'];

  it('is disabled when no API key is configured', async () => {
    const built = await startApp(null);

    for (const url of [...protectedRoutes, '/status']) {
      const response = await built.app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} should be open without an API key`).toBe(200);
    }
  });

  it('returns 401 with the documented envelope when the header is missing', async () => {
    const built = await startApp(API_KEY);

    for (const url of protectedRoutes) {
      const response = await built.app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} must require the API key`).toBe(401);
      expect(response.json<{ error: { message: string; code: string } }>()).toEqual({
        error: { message: 'Unauthorized', code: 'UNAUTHORIZED' },
      });
    }
  });

  it('leaves /status public: it is not part of the protected prefix list', async () => {
    const built = await startApp(API_KEY);
    const response = await built.app.inject({ method: 'GET', url: '/status' });
    expect(response.statusCode).toBe(200);
  });

  it('keeps /health public even when the API key is configured', async () => {
    const built = await startApp(API_KEY);
    const response = await built.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string; db: string }>()).toEqual({ status: 'ok', db: 'up' });
  });

  it('accepts the correct key', async () => {
    const built = await startApp(API_KEY);

    for (const url of ['/events', '/api/v1/events', '/metrics', '/docs/json', '/status']) {
      const response = await built.app.inject({
        method: 'GET',
        url,
        headers: { 'x-api-key': API_KEY },
      });
      expect(response.statusCode, `${url} should accept the configured key`).toBe(200);
    }
  });

  it('rejects a wrong key, including one of a different length', async () => {
    const built = await startApp(API_KEY);

    const wrongSameLength = await built.app.inject({
      method: 'GET',
      url: '/events',
      headers: { 'x-api-key': `${API_KEY.slice(0, -1)}X` },
    });
    expect(wrongSameLength.statusCode).toBe(401);

    const wrongLength = await built.app.inject({
      method: 'GET',
      url: '/events',
      headers: { 'x-api-key': 'short' },
    });
    expect(wrongLength.statusCode).toBe(401);

    const empty = await built.app.inject({
      method: 'GET',
      url: '/events',
      headers: { 'x-api-key': '' },
    });
    expect(empty.statusCode).toBe(401);
  });

  it('still validates the query for authenticated requests', async () => {
    const built = await startApp(API_KEY);
    const response = await built.app.inject({
      method: 'GET',
      url: '/events?limit=abc',
      headers: { 'x-api-key': API_KEY },
    });
    expect(response.statusCode).toBe(400);
  });
});
