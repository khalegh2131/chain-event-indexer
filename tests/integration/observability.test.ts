import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../../src/app';
import type { PoolLike } from '../../src/db/client';
import type { ChainClientLike, StatusResponse } from '../../src/types';
import {
  FakeChainClient,
  buildTestApp,
  buildTestConfig,
  createTestPool,
  makeTransferLog,
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

async function startApp(options: {
  config?: ReturnType<typeof buildTestConfig>;
  clients?: Map<string, ChainClientLike>;
} = {}): Promise<BuiltApp> {
  const built = await buildTestApp({
    pool,
    config: options.config,
    clients: options.clients,
  });
  builtApps.push(built.built);
  return built.built;
}

describe('GET /status', () => {
  it('reports uptime, poller state and an empty target before the first cycle', async () => {
    const built = await startApp();

    const response = await built.app.inject({ method: 'GET', url: '/status' });
    expect(response.statusCode).toBe(200);

    const body = response.json<StatusResponse>();
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.pollerEnabled).toBe(false);
    expect(body.pollerRunning).toBe(false);
    expect(body.chains).toEqual([
      {
        chainId: '1',
        latestBlock: null,
        targetBlock: null,
        lastPollAt: null,
        lastPollOkAt: null,
        lastError: null,
      },
    ]);
    expect(body.contracts[0]).toMatchObject({
      chainId: '1',
      address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      eventName: 'Transfer',
      lastIndexedBlock: null,
      targetBlock: null,
      lag: null,
    });
  });

  it('reports per-chain head information and per-contract lag after a cycle', async () => {
    const client = new FakeChainClient({
      latestBlock: 110n,
      logs: [makeTransferLog({ txHashSeed: 'aa', blockNumber: 105n, logIndex: 0 })],
    });
    const built = await startApp({
      config: buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 }),
      clients: new Map<string, ChainClientLike>([['1', client]]),
    });

    const cycle = await built.poller?.runChain('1');
    expect(cycle?.eventsInserted).toBe(1);

    const body = (await built.app.inject({ method: 'GET', url: '/status' })).json<StatusResponse>();
    expect(body.chains[0]).toMatchObject({ chainId: '1', latestBlock: '110', targetBlock: '108' });
    expect(body.chains[0]?.lastPollAt).not.toBeNull();
    expect(body.chains[0]?.lastError).toBeNull();
    expect(body.contracts[0]).toMatchObject({
      lastIndexedBlock: '108',
      targetBlock: '108',
      lag: '0',
    });
  });

  it('reports a lag when the cursor is behind the target', async () => {
    const client = new FakeChainClient({ latestBlock: 200n, logs: [] });
    const built = await startApp({
      config: buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 }),
      clients: new Map<string, ChainClientLike>([['1', client]]),
    });

    await built.poller?.runChain('1');

    // Simulate a contract that is deliberately behind the finalized head.
    await pool.query(
      'UPDATE ingestion_state SET last_finalized_block = 190',
    );

    const body = (await built.app.inject({ method: 'GET', url: '/status' })).json<StatusResponse>();
    expect(body.contracts[0]?.targetBlock).toBe('198');
    expect(body.contracts[0]?.lastIndexedBlock).toBe('190');
    expect(body.contracts[0]?.lag).toBe('8');
  });
});

describe('GET /metrics', () => {
  it('exposes every documented custom metric in Prometheus format', async () => {
    const client = new FakeChainClient({
      latestBlock: 110n,
      logs: [makeTransferLog({ txHashSeed: 'aa', blockNumber: 105n, logIndex: 0 })],
    });
    const built = await startApp({
      config: buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 }),
      clients: new Map<string, ChainClientLike>([['1', client]]),
    });

    await built.poller?.runChain('1');

    const response = await built.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');

    const body = response.body;
    expect(body).toContain('indexer_poll_success_total');
    expect(body).toContain('indexer_poll_error_total');
    expect(body).toContain('indexer_events_inserted_total');
    expect(body).toContain('indexer_events_conflict_total');
    expect(body).toContain('indexer_last_indexed_block');
    expect(body).toContain('indexer_target_block');
    expect(body).toContain('indexer_poll_duration_seconds');
    expect(body).toMatch(/indexer_events_inserted_total\{[^}]*event_name="Transfer"[^}]*\} 1/);
    expect(body).toMatch(/indexer_target_block\{[^}]*chain_id="1"[^}]*\} 108/);
  });

  it('counts conflicts when the same logs are ingested twice', async () => {
    const client = new FakeChainClient({
      latestBlock: 105n,
      logs: [makeTransferLog({ txHashSeed: 'aa', blockNumber: 102n, logIndex: 0 })],
    });
    const built = await startApp({
      config: buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 }),
      clients: new Map<string, ChainClientLike>([['1', client]]),
    });

    await built.poller?.runChain('1');
    await pool.query('UPDATE ingestion_state SET last_finalized_block = 99');
    await built.poller?.runChain('1');

    const body = (await built.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toMatch(/indexer_events_conflict_total\{[^}]*event_name="Transfer"[^}]*\} 1/);
  });

  it('does not use transaction hashes as a label', async () => {
    const built = await startApp();
    const body = (await built.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).not.toContain('tx_hash=');
    expect(body).not.toContain('block_number=');
  });
});

describe('GET /docs and /docs/json', () => {
  it('serves the OpenAPI document with the documented title, version and schemas', async () => {
    const built = await startApp();

    const response = await built.app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);

    const document = response.json<{
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    }>();

    expect(document.info.title).toBe('Chain Event Indexer API');
    expect(document.info.version).toBe('0.1.0');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/health', '/status', '/metrics', '/events', '/api/v1/events']),
    );
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining(['EventItem', 'EventsResponse', 'ErrorResponse']),
    );
  });

  it('documents the events query parameters and response schema', async () => {
    const built = await startApp();

    const document = (
      await built.app.inject({ method: 'GET', url: '/docs/json' })
    ).json<{
      paths: Record<
        string,
        {
          get: {
            parameters?: Array<{ name: string }>;
            responses?: Record<string, unknown>;
          };
        }
      >;
    }>();

    const parameters = document.paths['/api/v1/events']?.get.parameters ?? [];
    expect(parameters.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining([
        'chainId',
        'address',
        'eventName',
        'fromBlock',
        'toBlock',
        'txHash',
        'cursor',
        'limit',
      ]),
    );
    expect(Object.keys(document.paths['/api/v1/events']?.get.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401']),
    );
  });

  it('serves the Swagger UI shell', async () => {
    const built = await startApp();
    const response = await built.app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });
});
