import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPoller } from '../../src/chain/poller';
import { createPollerStatusStore, type PollerStatusStore } from '../../src/chain/status';
import { runPollCycle, type PollCycleResult } from '../../src/chain/ingest';
import type { PoolLike } from '../../src/db/client';
import { registerContracts } from '../../src/db/repositories/contracts';
import { countEventLogs } from '../../src/db/repositories/events';
import { getIngestionState } from '../../src/db/repositories/state';
import { createMetrics, type Metrics } from '../../src/metrics/metrics';
import type { RetryOptions } from '../../src/utils/retry';
import type {
  ChainClientLike,
  NormalizedConfig,
  RawLog,
  RegisteredContractMap,
} from '../../src/types';
import {
  APPROVAL_TOPIC0,
  FakeChainClient,
  buildTestConfig,
  buildTwoContractConfig,
  createTestPool,
  makeApprovalLog,
  makeTransferLog,
  requireContract,
  testLogger,
  truncateAll,
} from './helpers';

let pool: PoolLike;

beforeAll(async () => {
  pool = createTestPool();
  await pool.query('SELECT 1');
});

afterEach(async () => {
  await truncateAll(pool);
});

afterAll(async () => {
  await pool.end();
});

interface CycleOptions {
  config: NormalizedConfig;
  latestBlock: bigint;
  logs?: RawLog[];
  client?: ChainClientLike;
  clients?: Map<string, ChainClientLike>;
  metrics?: Metrics;
  status?: PollerStatusStore;
  retryOptions?: RetryOptions;
  contracts?: RegisteredContractMap;
}

interface CycleOutcome {
  result: PollCycleResult;
  contracts: RegisteredContractMap;
  metrics: Metrics;
  status: PollerStatusStore;
  client: ChainClientLike;
}

async function cycle(options: CycleOptions): Promise<CycleOutcome> {
  const contracts =
    options.contracts ?? (await registerContracts(pool, options.config.contracts));
  const client =
    options.client ??
    new FakeChainClient({ latestBlock: options.latestBlock, logs: options.logs ?? [] });
  const chainId = options.config.chains[0]?.chainId ?? '1';
  const clients =
    options.clients ?? new Map<string, ChainClientLike>([[chainId, client]]);
  const metrics = options.metrics ?? createMetrics({ collectDefaultMetrics: false });
  const status = options.status ?? createPollerStatusStore();

  const result = await runPollCycle({
    pool,
    config: options.config,
    contracts,
    clients,
    logger: testLogger,
    metrics,
    status,
    retryOptions: options.retryOptions ?? { attempts: 1, jitter: 'none' },
    sleep: async () => undefined,
  });

  return { result, contracts, metrics, status, client };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('runPollCycle confirmations threshold', () => {
  it('only processes blocks at or below latest - confirmations', async () => {
    const config = buildTestConfig({ startBlock: '90', confirmations: 2, maxBlockRange: 100 });
    const logs = [
      makeTransferLog({ txHashSeed: 'a1', blockNumber: 97n, logIndex: 0 }) as RawLog,
      makeTransferLog({ txHashSeed: 'a2', blockNumber: 98n, logIndex: 0 }) as RawLog,
      makeTransferLog({ txHashSeed: 'a3', blockNumber: 99n, logIndex: 0 }) as RawLog,
    ];

    const outcome = await cycle({ config, latestBlock: 100n, logs });

    expect(outcome.result.chains[0]?.latestBlock).toBe('100');
    expect(outcome.result.chains[0]?.targetBlock).toBe('98');
    expect(outcome.result.eventsInserted).toBe(2);
    expect(await countEventLogs(pool)).toBe(2);
  });

  it('skips a chain whose head has not reached the threshold', async () => {
    const config = buildTestConfig({ startBlock: '0', confirmations: 12 });
    const outcome = await cycle({ config, latestBlock: 5n, logs: [] });

    expect(outcome.result.chains[0]?.skipped).toBe(true);
    expect(outcome.result.chains[0]?.targetBlock).toBeNull();
    expect(outcome.result.eventsInserted).toBe(0);
    expect(outcome.result.errors).toBe(0);
  });
});

describe('runPollCycle cursor initialization', () => {
  it('starts one block before a configured startBlock', async () => {
    const config = buildTestConfig({ startBlock: '95', confirmations: 2, maxBlockRange: 10 });
    const logs = [
      makeTransferLog({ txHashSeed: 'b1', blockNumber: 94n, logIndex: 0 }) as RawLog,
      makeTransferLog({ txHashSeed: 'b2', blockNumber: 95n, logIndex: 0 }) as RawLog,
      makeTransferLog({ txHashSeed: 'b3', blockNumber: 96n, logIndex: 0 }) as RawLog,
    ];

    const outcome = await cycle({ config, latestBlock: 100n, logs });
    const contract = requireContract(outcome.contracts, config.contracts[0]!);

    expect(outcome.result.eventsInserted).toBe(2);
    expect(await countEventLogs(pool)).toBe(2);
    const state = await getIngestionState(pool, contract.id);
    expect(state?.lastFinalizedBlock).toBe('98');
  });

  it('starts at the finalized head without backfilling when startBlock is omitted', async () => {
    const config = buildTestConfig({ confirmations: 2, maxBlockRange: 10 });
    const logs = [
      makeTransferLog({ txHashSeed: 'c1', blockNumber: 50n, logIndex: 0 }) as RawLog,
    ];

    const outcome = await cycle({ config, latestBlock: 100n, logs });
    const contract = requireContract(outcome.contracts, config.contracts[0]!);
    const client = outcome.client as FakeChainClient;

    expect(outcome.result.chains[0]?.contracts[0]?.skipped).toBe(true);
    expect(outcome.result.eventsInserted).toBe(0);
    expect(client.logCalls).toHaveLength(0);
    const state = await getIngestionState(pool, contract.id);
    expect(state?.lastFinalizedBlock).toBe('98');
  });

  it('supports startBlock 0 without ever querying a negative block', async () => {
    const config = buildTestConfig({ startBlock: '0', confirmations: 2, maxBlockRange: 10 });
    const logs = [makeTransferLog({ txHashSeed: 'd1', blockNumber: 0n, logIndex: 0 }) as RawLog];

    const outcome = await cycle({ config, latestBlock: 5n, logs });
    const client = outcome.client as FakeChainClient;

    expect(client.logCalls[0]?.fromBlock).toBe(0n);
    expect(outcome.result.eventsInserted).toBe(1);
  });
});

describe('runPollCycle range handling', () => {
  it('splits the backlog into maxBlockRange windows', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const outcome = await cycle({ config, latestBlock: 130n, logs: [] });
    const client = outcome.client as FakeChainClient;

    expect(client.logCalls.map((call) => [String(call.fromBlock), String(call.toBlock)])).toEqual([
      ['100', '109'],
      ['110', '119'],
      ['120', '128'],
    ]);
    expect(outcome.result.chains[0]?.contracts[0]?.rangesProcessed).toBe(3);
  });

  it('advances the cursor even when a window contains no events', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const outcome = await cycle({ config, latestBlock: 130n, logs: [] });
    const contract = requireContract(outcome.contracts, config.contracts[0]!);

    expect(outcome.result.eventsInserted).toBe(0);
    expect((await getIngestionState(pool, contract.id))?.lastFinalizedBlock).toBe('128');
  });

  it('does nothing when the cursor is already at the target', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const first = await cycle({ config, latestBlock: 110n, logs: [] });
    const client = first.client as FakeChainClient;
    const callsAfterFirst = client.logCalls.length;

    const second = await cycle({
      config,
      latestBlock: 110n,
      logs: [],
      contracts: first.contracts,
      client,
    });

    expect(second.result.chains[0]?.contracts[0]?.skipped).toBe(true);
    expect(client.logCalls).toHaveLength(callsAfterFirst);
  });
});

describe('runPollCycle idempotency', () => {
  it('ignores duplicates when the same range is replayed', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const logs: RawLog[] = [];
    for (let index = 0; index < 9; index += 1) {
      logs.push(
        makeTransferLog({
          txHashSeed: `e${index}`,
          blockNumber: 100n + BigInt(index),
          logIndex: index,
        }) as RawLog,
      );
    }

    const first = await cycle({ config, latestBlock: 110n, logs });
    expect(first.result.eventsInserted).toBe(9);
    expect(await countEventLogs(pool)).toBe(9);

    const contract = requireContract(first.contracts, config.contracts[0]!);
    // Rewind the cursor behind the GREATEST() guard to force a replay.
    await pool.query('UPDATE ingestion_state SET last_finalized_block = 99 WHERE contract_id = $1', [
      contract.id,
    ]);

    const second = await cycle({
      config,
      latestBlock: 110n,
      logs,
      contracts: first.contracts,
      client: first.client,
    });

    expect(second.result.eventsInserted).toBe(0);
    expect(second.result.eventsConflicted).toBe(9);
    expect(await countEventLogs(pool)).toBe(9);
  });

  it('keeps the cursor monotonic', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const first = await cycle({ config, latestBlock: 120n, logs: [] });
    const contract = requireContract(first.contracts, config.contracts[0]!);

    await pool.query('UPDATE ingestion_state SET last_finalized_block = 105 WHERE contract_id = $1', [
      contract.id,
    ]);

    const replay = await cycle({
      config,
      latestBlock: 120n,
      logs: [],
      contracts: first.contracts,
      client: first.client,
    });

    const state = await getIngestionState(pool, contract.id);
    expect(state?.lastFinalizedBlock).toBe('118');
    expect(replay.result.eventsInserted).toBe(0);
  });
});

describe('runPollCycle failure isolation', () => {
  it('continues with the other contracts when one fails', async () => {
    const config = buildTwoContractConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const inner = new FakeChainClient({
      latestBlock: 110n,
      logs: [
        makeTransferLog({ txHashSeed: 'f1', blockNumber: 105n, logIndex: 0 }) as RawLog,
        makeApprovalLog({ txHashSeed: 'f2', blockNumber: 106n, logIndex: 1 }) as RawLog,
      ],
    });
    const failing: ChainClientLike = {
      getBlockNumber: () => inner.getBlockNumber(),
      getLogs: async (args) => {
        if (args.topics[0]?.toLowerCase() === APPROVAL_TOPIC0) {
          throw new Error('provider exploded');
        }
        return inner.getLogs(args);
      },
    };

    const outcome = await cycle({ config, latestBlock: 110n, client: failing });

    const contracts = outcome.result.chains[0]?.contracts ?? [];
    expect(contracts).toHaveLength(2);

    const transfer = contracts.find((entry) => entry.eventName === 'Transfer');
    const approval = contracts.find((entry) => entry.eventName === 'Approval');

    expect(transfer?.error).toBeNull();
    expect(transfer?.eventsInserted).toBe(1);
    expect(approval?.error).toContain('provider exploded');
    expect(outcome.result.errors).toBe(1);
    expect(await countEventLogs(pool)).toBe(1);
  });

  it('retries a transient head fetch and still succeeds', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const client = new FakeChainClient({
      latestBlock: 110n,
      logs: [makeTransferLog({ txHashSeed: 'g1', blockNumber: 105n, logIndex: 0 }) as RawLog],
      failures: 1,
    });

    const outcome = await cycle({
      config,
      latestBlock: 110n,
      client,
      retryOptions: { attempts: 3, jitter: 'none', baseDelayMs: 1 },
    });

    expect(outcome.result.chains[0]?.error).toBeNull();
    expect(outcome.result.eventsInserted).toBe(1);
    expect((client as FakeChainClient).blockNumberCalls).toBe(2);
  });

  it('records a chain level error when the RPC stays unavailable', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const client = new FakeChainClient({ latestBlock: 110n, logs: [], failures: 5 });
    const status = createPollerStatusStore();

    const outcome = await cycle({
      config,
      latestBlock: 110n,
      client,
      status,
      retryOptions: { attempts: 2, jitter: 'none', baseDelayMs: 1 },
    });

    expect(outcome.result.chains[0]?.skipped).toBe(true);
    expect(outcome.result.chains[0]?.error).toContain('Service Unavailable');
    expect(outcome.result.errors).toBe(1);
    expect(status.getChain('1')?.lastError).toContain('Service Unavailable');
  });

  it('records a contract failure and keeps the cursor where it was', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const failing: ChainClientLike = {
      getBlockNumber: async () => 110n,
      getLogs: async () => {
        throw new Error('logs endpoint unavailable');
      },
    };

    const outcome = await cycle({ config, latestBlock: 110n, client: failing });
    const contract = requireContract(outcome.contracts, config.contracts[0]!);

    expect(outcome.result.chains[0]?.contracts[0]?.error).toContain('logs endpoint unavailable');
    // startBlock 100 initialises the cursor at 99, which is where it must stay.
    expect((await getIngestionState(pool, contract.id))?.lastFinalizedBlock).toBe('99');
    expect(outcome.status.getContract(contract.id)).toBeUndefined();
  });
});

describe('poller orchestration', () => {
  it('runs a full cycle through runOnce()', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const contracts = await registerContracts(pool, config.contracts);
    const client = new FakeChainClient({
      latestBlock: 110n,
      logs: [makeTransferLog({ txHashSeed: 'h1', blockNumber: 105n, logIndex: 0 }) as RawLog],
    });
    const status = createPollerStatusStore();
    const metrics = createMetrics({ collectDefaultMetrics: false });

    const poller = createPoller({
      pool,
      config,
      contracts,
      clients: new Map<string, ChainClientLike>([['1', client]]),
      logger: testLogger,
      metrics,
      status,
      retryOptions: { attempts: 1, jitter: 'none' },
      sleep: async () => undefined,
    });

    const result = await poller.runOnce();

    expect(result.eventsInserted).toBe(1);
    expect(poller.isRunning()).toBe(false);
    await poller.stop();
  });

  it('skips an overlapping cycle for the same chain', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const contracts = await registerContracts(pool, config.contracts);
    const gate = deferred();
    const slowClient: ChainClientLike = {
      getBlockNumber: async () => 110n,
      getLogs: async () => {
        await gate.promise;
        return [];
      },
    };

    const poller = createPoller({
      pool,
      config,
      contracts,
      clients: new Map<string, ChainClientLike>([['1', slowClient]]),
      logger: testLogger,
      metrics: createMetrics({ collectDefaultMetrics: false }),
      status: createPollerStatusStore(),
      retryOptions: { attempts: 1, jitter: 'none' },
      sleep: async () => undefined,
    });

    const first = poller.runChain('1');
    const overlapping = await poller.runChain('1');
    expect(overlapping).toBeNull();
    expect(poller.isChainBusy('1')).toBe(true);

    gate.resolve();
    const firstResult = await first;
    expect(firstResult?.eventsInserted).toBe(0);
    expect(poller.isChainBusy('1')).toBe(false);
    await poller.stop();
  });

  it('toggles the running flag and stops cleanly', async () => {
    const config = buildTestConfig({ startBlock: '100', confirmations: 2, maxBlockRange: 10 });
    const contracts = await registerContracts(pool, config.contracts);
    const status = createPollerStatusStore();

    const poller = createPoller({
      pool,
      config,
      contracts,
      clients: new Map<string, ChainClientLike>([
        ['1', new FakeChainClient({ latestBlock: 110n, logs: [] })],
      ]),
      logger: testLogger,
      metrics: createMetrics({ collectDefaultMetrics: false }),
      status,
      retryOptions: { attempts: 1, jitter: 'none' },
      sleep: async () => undefined,
    });

    poller.start();
    expect(poller.isRunning()).toBe(true);
    expect(status.isRunning()).toBe(true);

    await poller.stop();
    expect(poller.isRunning()).toBe(false);
    expect(status.isRunning()).toBe(false);
  });
});
