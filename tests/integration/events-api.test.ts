import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../../src/app';
import { getIngestionState } from '../../src/db/repositories/state';
import type { PoolLike } from '../../src/db/client';
import type { EventItem, EventsResponse, NormalizedConfig, RawLog } from '../../src/types';
import {
  buildTestApp,
  buildTestConfig,
  createTestPool,
  makeTransferLog,
  requireContract,
  seedEvents,
  truncateAll,
} from './helpers';

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

async function startApp(options: { apiKey?: string | null } = {}): Promise<BuiltApp> {
  const built = await buildTestApp({ pool, apiKey: options.apiKey ?? null });
  app = built.built;
  return app;
}

function makeLogs(count: number, startBlock = 100n): RawLog[] {
  const logs: RawLog[] = [];
  for (let index = 0; index < count; index += 1) {
    logs.push(
      makeTransferLog({
        txHashSeed: `a${index.toString(16).padStart(2, '0')}`,
        blockNumber: startBlock + BigInt(index),
        logIndex: index,
        value: BigInt(1_000_000 + index),
      }) as RawLog,
    );
  }
  return logs;
}

async function seed(count = 5): Promise<NormalizedConfig> {
  const config = buildTestConfig();
  await seedEvents(pool, config, makeLogs(count));
  return config;
}

describe('GET /events', () => {
  it('returns indexed events ordered by block number and log index', async () => {
    await seed(3);
    const built = await startApp();

    const response = await built.app.inject({ method: 'GET', url: '/events' });
    expect(response.statusCode).toBe(200);

    const body = response.json<EventsResponse>();
    expect(body.items).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item) => item.blockNumber)).toEqual(['100', '101', '102']);
    expect(body.items.map((item) => item.eventName)).toEqual([
      'Transfer',
      'Transfer',
      'Transfer',
    ]);

    const first = body.items[0] as EventItem;
    expect(first.chainId).toBe('1');
    expect(first.contractAddress).toBe('0xdac17f958d2ee523a2206206994597c13d831ec7');
    expect(first.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.rawTopics).toHaveLength(3);
    expect(first.data).toMatch(/^0x[0-9a-f]{64}$/);
    expect(typeof first.indexedAt).toBe('string');
    expect((first.args as { value: string }).value).toBe('1000000');
  });

  it('exposes every value as a string, never a bigint', async () => {
    await seed(1);
    const built = await startApp();

    const response = await built.app.inject({ method: 'GET', url: '/api/v1/events' });
    const raw = response.body;
    expect(raw).not.toContain('n,');
    const body = response.json<EventsResponse>();
    const item = body.items[0] as EventItem;
    for (const value of [
      item.id,
      item.chainId,
      item.blockNumber,
      item.logIndex,
      item.transactionIndex,
    ]) {
      expect(typeof value).toBe('string');
    }
  });

  it('returns an empty page when nothing has been indexed', async () => {
    const built = await startApp();
    const response = await built.app.inject({ method: 'GET', url: '/events' });
    expect(response.statusCode).toBe(200);
    expect(response.json<EventsResponse>()).toEqual({ items: [], nextCursor: null });
  });
});

describe('GET /events and GET /api/v1/events are the same handler', () => {
  it('returns identical payloads', async () => {
    await seed(4);
    const built = await startApp();

    const alias = await built.app.inject({ method: 'GET', url: '/events?limit=10' });
    const versioned = await built.app.inject({ method: 'GET', url: '/api/v1/events?limit=10' });

    expect(alias.statusCode).toBe(200);
    expect(versioned.statusCode).toBe(200);
    expect(versioned.json<EventsResponse>()).toEqual(alias.json<EventsResponse>());
  });
});

describe('pagination', () => {
  it('walks the whole result set with nextCursor', async () => {
    await seed(5);
    const built = await startApp();

    const pages: string[][] = [];
    let cursor: string | null = null;
    let guard = 0;

    do {
      const url: string = cursor
        ? `/api/v1/events?limit=2&cursor=${encodeURIComponent(cursor)}`
        : '/api/v1/events?limit=2';
      const response = await built.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      const body = response.json<EventsResponse>();
      pages.push(body.items.map((item) => item.blockNumber));
      cursor = body.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 10);

    expect(pages).toEqual([['100', '101'], ['102', '103'], ['104']]);
    expect(cursor).toBeNull();
  });

  it('returns nextCursor null when the page is not full', async () => {
    await seed(2);
    const built = await startApp();
    const response = await built.app.inject({ method: 'GET', url: '/events?limit=20' });
    const body = response.json<EventsResponse>();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it('defaults to a limit of 20 (max 100)', async () => {
    await seed(5);
    const built = await startApp();
    const response = await built.app.inject({ method: 'GET', url: '/events' });
    expect(response.json<EventsResponse>().items).toHaveLength(5);

    const tooLarge = await built.app.inject({ method: 'GET', url: '/events?limit=101' });
    expect(tooLarge.statusCode).toBe(400);
  });
});

describe('filters', () => {
  it('filters by chainId, address, eventName, block range and txHash', async () => {
    const config = buildTestConfig();
    const logs = makeLogs(3);
    await seedEvents(pool, config, logs);
    const built = await startApp();

    const byChain = await built.app.inject({ method: 'GET', url: '/events?chainId=1' });
    expect(byChain.json<EventsResponse>().items).toHaveLength(3);

    const otherChain = await built.app.inject({ method: 'GET', url: '/events?chainId=137' });
    expect(otherChain.json<EventsResponse>().items).toHaveLength(0);

    const byAddress = await built.app.inject({
      method: 'GET',
      url: '/events?address=0xdAC17F958D2ee523a2206206994597C13D831ec7',
    });
    expect(byAddress.json<EventsResponse>().items).toHaveLength(3);

    const byEvent = await built.app.inject({ method: 'GET', url: '/events?eventName=Approval' });
    expect(byEvent.json<EventsResponse>().items).toHaveLength(0);

    const byRange = await built.app.inject({
      method: 'GET',
      url: '/events?fromBlock=101&toBlock=102',
    });
    expect(byRange.json<EventsResponse>().items.map((item) => item.blockNumber)).toEqual([
      '101',
      '102',
    ]);

    const txHash = logs[1]?.transactionHash ?? '';
    const byTx = await built.app.inject({ method: 'GET', url: `/events?txHash=${txHash}` });
    expect(byTx.json<EventsResponse>().items).toHaveLength(1);
    expect(byTx.json<EventsResponse>().items[0]?.blockNumber).toBe('101');
  });

  it('combines filters', async () => {
    const config = buildTestConfig();
    await seedEvents(pool, config, makeLogs(4));
    const built = await startApp();

    const response = await built.app.inject({
      method: 'GET',
      url: '/api/v1/events?chainId=1&eventName=Transfer&fromBlock=102&toBlock=103&limit=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<EventsResponse>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.blockNumber).toBe('102');
    expect(body.nextCursor).not.toBeNull();
  });
});

describe('validation', () => {
  it.each([
    ['/events?limit=0', 'limit below range'],
    ['/events?limit=101', 'limit above range'],
    ['/events?limit=abc', 'non numeric limit'],
    ['/events?chainId=abc', 'non numeric chainId'],
    ['/events?fromBlock=abc', 'non numeric fromBlock'],
    ['/events?txHash=0x1234', 'malformed txHash'],
    ['/events?cursor=not-a-cursor', 'malformed cursor'],
    ['/events?address=0xnotanaddress', 'invalid address'],
    ['/events?fromBlock=10&toBlock=5', 'fromBlock after toBlock'],
    ['/events?unknown=1', 'unknown parameter'],
  ])('returns 400 for %s (%s)', async (url, label) => {
    await seed(1);
    const built = await startApp();

    const response = await built.app.inject({ method: 'GET', url });
    expect(response.statusCode, label).toBe(400);
    const body = response.json<{ error: { message: string; code: string } }>();
    const expectedCode = url.includes('cursor=') ? 'INVALID_CURSOR' : 'VALIDATION_ERROR';
    expect(body.error.code, label).toBe(expectedCode);
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('returns 401 rather than 400 when the api key is missing', async () => {
    await seed(1);
    const built = await startApp({ apiKey: 'secret' });

    const response = await built.app.inject({ method: 'GET', url: '/events?limit=abc' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for an unknown route', async () => {
    const built = await startApp();
    const response = await built.app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});

describe('persistence', () => {
  it('serves the same events from a brand new application instance', async () => {
    const config = buildTestConfig();
    await seedEvents(pool, config, makeLogs(2, 900n));

    const first = await startApp();
    const firstBody = (
      await first.app.inject({ method: 'GET', url: '/events' })
    ).json<EventsResponse>();
    await first.close();

    const second = await buildTestApp({ pool });
    app = second.built;
    const secondBody = (
      await second.built.app.inject({ method: 'GET', url: '/events' })
    ).json<EventsResponse>();

    expect(secondBody).toEqual(firstBody);
    expect(secondBody.items.map((item) => item.blockNumber)).toEqual(['900', '901']);
  });

  it('keeps the ingestion cursor in the database, not in memory', async () => {
    const config = buildTestConfig({ startBlock: '100' });
    const contracts = await seedEvents(pool, config, []);
    const contract = requireContract(contracts.contracts, config.contracts[0]!);

    const built = await startApp();
    expect(await getIngestionState(pool, contract.id)).toBeNull();
    expect(built.app.server.listening).toBe(false);

    await pool.query(
      'INSERT INTO ingestion_state (contract_id, last_finalized_block) VALUES ($1, 123)',
      [contract.id],
    );

    const status = await built.app.inject({ method: 'GET', url: '/status' });
    expect(status.statusCode).toBe(200);
    const body = status.json<{ contracts: Array<{ lastIndexedBlock: string | null }> }>();
    expect(body.contracts[0]?.lastIndexedBlock).toBe('123');
  });
});
