import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/client';
import { listContracts, registerContracts } from '../../src/db/repositories/contracts';
import {
  countEventLogs,
  insertEventBatch,
  mapEventRow,
  queryEvents,
} from '../../src/db/repositories/events';
import {
  deleteIngestionState,
  getIngestionState,
  listIngestionStates,
  upsertIngestionState,
} from '../../src/db/repositories/state';
import type { EventInsertRow, RawLog } from '../../src/types';
import {
  buildTestConfig,
  createTestPool,
  makeTransferLog,
  requireContract,
  seedEvents,
  truncateAll,
} from './helpers';

const pool = createTestPool();

beforeAll(async () => {
  await pool.query('SELECT 1');
});

afterEach(async () => {
  await truncateAll(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('contracts repository', () => {
  it('registers configured contracts and is idempotent', async () => {
    const config = buildTestConfig();

    const first = await registerContracts(pool, config.contracts);
    const registeredFirst = requireContract(first, config.contracts[0]!);

    const second = await registerContracts(pool, config.contracts);
    const registeredSecond = requireContract(second, config.contracts[0]!);

    expect(registeredSecond.id).toBe(registeredFirst.id);
    expect(registeredSecond.address).toBe(config.contracts[0]?.address);
    expect(registeredSecond.topic0).toBe(config.contracts[0]?.topic0);
    expect(registeredSecond.active).toBe(true);

    const all = await listContracts(pool);
    expect(all).toHaveLength(1);
  });

  it('refreshes metadata and preserves start_block when it disappears from config', async () => {
    const withStart = buildTestConfig({ startBlock: '500' });
    await registerContracts(pool, withStart.contracts);

    const withoutStart = buildTestConfig();
    const refreshed = await registerContracts(pool, withoutStart.contracts);
    const registered = requireContract(refreshed, withoutStart.contracts[0]!);

    expect(registered.startBlock).toBe('500');
  });
});

describe('events repository', () => {
  it('reports inserted and conflicting rows', async () => {
    const config = buildTestConfig();
    const logs = [
      makeTransferLog({ txHashSeed: 'aa', blockNumber: 100n, logIndex: 0 }) as RawLog,
      makeTransferLog({ txHashSeed: 'bb', blockNumber: 101n, logIndex: 1 }) as RawLog,
    ];
    const { contracts } = await seedEvents(pool, config, logs);
    const contract = requireContract(contracts, config.contracts[0]!);

    const rows: EventInsertRow[] = logs.map((log, index) => ({
      chainId: '1',
      contractId: contract.id,
      txHash: log.transactionHash ?? '',
      logIndex: String(index),
      blockNumber: String(log.blockNumber ?? 0n),
      blockHash: log.blockHash ?? '',
      txIndex: '0',
      eventName: 'Transfer',
      args: { index },
      rawTopics: [...log.topics],
      data: log.data,
    }));

    // Both rows already exist (same chain/tx/log index) -> pure conflicts.
    const result = await withTransaction(pool, (tx) => insertEventBatch(tx, rows));
    expect(result.inserted).toBe(0);
    expect(result.conflicts).toBe(2);
    expect(await countEventLogs(pool)).toBe(2);
  });

  it('splits large batches without exceeding parameter limits', async () => {
    const config = buildTestConfig();
    const logs: RawLog[] = [];
    for (let index = 0; index < 501; index += 1) {
      logs.push(
        makeTransferLog({
          txHashSeed: `e${index.toString(16).padStart(2, '0')}`,
          blockNumber: 1000n + BigInt(index),
          logIndex: 0,
        }) as RawLog,
      );
    }

    const { contracts } = await seedEvents(pool, config, logs);
    const contract = requireContract(contracts, config.contracts[0]!);

    const rows: EventInsertRow[] = [];
    for (let index = 0; index < 501; index += 1) {
      rows.push({
        chainId: '1',
        contractId: contract.id,
        txHash: `0x${`f${index.toString(16).padStart(2, '0')}`.repeat(32).slice(0, 64)}`,
        logIndex: '0',
        blockNumber: String(2000 + index),
        blockHash: `0x${'11'.repeat(32)}`,
        txIndex: '0',
        eventName: 'Transfer',
        args: { index },
        rawTopics: [`0x${'22'.repeat(32)}`],
        data: '0x',
      });
    }

    const result = await withTransaction(pool, (tx) => insertEventBatch(tx, rows));
    expect(result.inserted).toBe(501);
    expect(result.conflicts).toBe(0);
    expect(await countEventLogs(pool)).toBe(1002);
  });

  it('orders results by block number, log index and id', async () => {
    const config = buildTestConfig();
    const logs: RawLog[] = [
      makeTransferLog({ txHashSeed: 'c1', blockNumber: 120n, logIndex: 5 }) as RawLog,
      makeTransferLog({ txHashSeed: 'c2', blockNumber: 118n, logIndex: 9 }) as RawLog,
      makeTransferLog({ txHashSeed: 'c3', blockNumber: 120n, logIndex: 1 }) as RawLog,
    ];
    await seedEvents(pool, config, logs);

    const rows = await queryEvents(pool, { limit: 10 });
    expect(rows.map((row) => `${row.block_number}:${row.log_index}`)).toEqual([
      '118:9',
      '120:1',
      '120:5',
    ]);
  });

  it('applies every supported filter', async () => {
    const config = buildTestConfig();
    const logs: RawLog[] = [
      makeTransferLog({ txHashSeed: 'd1', blockNumber: 100n, logIndex: 0 }) as RawLog,
      makeTransferLog({ txHashSeed: 'd2', blockNumber: 200n, logIndex: 1 }) as RawLog,
      makeTransferLog({ txHashSeed: 'd3', blockNumber: 300n, logIndex: 2 }) as RawLog,
    ];
    await seedEvents(pool, config, logs);
    const contractAddress = config.contracts[0]?.address ?? '';

    expect((await queryEvents(pool, { limit: 10, chainId: '1' })).length).toBe(3);
    expect((await queryEvents(pool, { limit: 10, chainId: '137' })).length).toBe(0);
    expect((await queryEvents(pool, { limit: 10, address: contractAddress })).length).toBe(3);
    expect((await queryEvents(pool, { limit: 10, eventName: 'Transfer' })).length).toBe(3);
    expect((await queryEvents(pool, { limit: 10, eventName: 'Approval' })).length).toBe(0);
    expect((await queryEvents(pool, { limit: 10, fromBlock: '200' })).length).toBe(2);
    expect((await queryEvents(pool, { limit: 10, toBlock: '200' })).length).toBe(2);
    expect(
      (await queryEvents(pool, { limit: 10, fromBlock: '150', toBlock: '250' })).length,
    ).toBe(1);
    expect(
      (
        await queryEvents(pool, {
          limit: 10,
          txHash: (logs[1]?.transactionHash ?? '').toUpperCase().replace('0X', '0x'),
        })
      ).length,
    ).toBe(1);
  });

  it('paginates with a cursor on the row id', async () => {
    const config = buildTestConfig();
    const logs: RawLog[] = [];
    for (let index = 0; index < 5; index += 1) {
      logs.push(
        makeTransferLog({
          txHashSeed: `a${index}`,
          blockNumber: 100n + BigInt(index),
          logIndex: 0,
        }) as RawLog,
      );
    }
    await seedEvents(pool, config, logs);

    const firstPage = await queryEvents(pool, { limit: 2 });
    // `limit + 1` rows are returned on purpose so the caller can detect whether
    // a next page exists.
    expect(firstPage).toHaveLength(3);
    const cursorId = firstPage[1]?.id ?? '0';

    const secondPage = await queryEvents(pool, { limit: 2, cursorId });
    expect(secondPage.map((row) => row.block_number)).toEqual(['102', '103', '104']);
  });

  it('maps database rows to JSON-safe API items', async () => {
    const config = buildTestConfig();
    await seedEvents(pool, config, [
      makeTransferLog({
        txHashSeed: 'ab',
        blockNumber: 21_000_000n,
        logIndex: 42,
        value: 900719925474099300000n,
      }) as RawLog,
    ]);

    const rows = await queryEvents(pool, { limit: 1 });
    const item = mapEventRow(rows[0]!);

    expect(typeof item.id).toBe('string');
    expect(item.chainId).toBe('1');
    expect(item.blockNumber).toBe('21000000');
    expect(item.logIndex).toBe('42');
    expect(item.transactionIndex).toBe('0');
    expect(item.rawTopics).toHaveLength(3);
    expect((item.args as { value: string }).value).toBe('900719925474099300000');
    expect(() => JSON.stringify(item)).not.toThrow();
  });
});

describe('ingestion state repository', () => {
  it('creates, reads and advances the cursor monotonically', async () => {
    const config = buildTestConfig();
    const { contracts } = await seedEvents(pool, config, []);
    const contract = requireContract(contracts, config.contracts[0]!);

    expect(await getIngestionState(pool, contract.id)).toBeNull();

    const created = await upsertIngestionState(pool, contract.id, '100');
    expect(created.lastFinalizedBlock).toBe('100');

    const advanced = await upsertIngestionState(pool, contract.id, '150');
    expect(advanced.lastFinalizedBlock).toBe('150');

    // Never moves backwards, even if a stale cycle reports an older block.
    const stale = await upsertIngestionState(pool, contract.id, '120');
    expect(stale.lastFinalizedBlock).toBe('150');

    const listed = await listIngestionStates(pool);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.contractId).toBe(contract.id);
  });

  it('supports the -1 sentinel and deletion', async () => {
    const config = buildTestConfig({ startBlock: '0' });
    const { contracts } = await seedEvents(pool, config, []);
    const contract = requireContract(contracts, config.contracts[0]!);

    const created = await upsertIngestionState(pool, contract.id, '-1');
    expect(created.lastFinalizedBlock).toBe('-1');

    expect(await deleteIngestionState(pool, contract.id)).toBe(1);
    expect(await getIngestionState(pool, contract.id)).toBeNull();
  });
});
