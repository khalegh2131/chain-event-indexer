import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, listMigrationFiles, runMigrations } from '../../src/db/migrate';
import { withTransaction } from '../../src/db/client';
import { insertEventBatch } from '../../src/db/repositories/events';
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

describe('migration runner', () => {
  it('discovers migrations in lexicographic order', () => {
    const files = listMigrationFiles(defaultMigrationsDir());
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toBe('0001_init.sql');
    expect([...files].sort()).toEqual(files);
  });

  it('created every table and the required indexes', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tableNames = tables.rows.map((row) => row.table_name);
    expect(tableNames).toEqual(
      expect.arrayContaining(['contracts', 'event_logs', 'ingestion_state', 'schema_migrations']),
    );

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'event_logs'`,
    );
    const indexNames = indexes.rows.map((row) => row.indexname);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'event_logs_chain_block_log_idx',
        'event_logs_contract_block_log_idx',
        'event_logs_tx_hash_idx',
      ]),
    );
  });

  it('runs a second time without applying anything (idempotent)', async () => {
    const second = await runMigrations(pool, defaultMigrationsDir());
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0001_init.sql');
  });

  it('records applied migrations once', async () => {
    const rows = await pool.query<{ name: string; count: string }>(
      `SELECT name, COUNT(*)::text AS count FROM schema_migrations GROUP BY name`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.name).toBe('0001_init.sql');
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('fails loudly on a broken migration and does not record it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cei-migrate-'));
    try {
      fs.copyFileSync(
        path.join(defaultMigrationsDir(), '0001_init.sql'),
        path.join(dir, '0001_init.sql'),
      );
      fs.writeFileSync(path.join(dir, '9999_broken.sql'), 'SELECT this_column_does_not_exist;\n');

      await expect(runMigrations(pool, dir)).rejects.toThrow(/9999_broken\.sql failed/);

      const recorded = await pool.query<{ name: string }>(
        `SELECT name FROM schema_migrations WHERE name = '9999_broken.sql'`,
      );
      expect(recorded.rows).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schema constraints', () => {
  it('enforces the unique contract identity', async () => {
    const config = buildTestConfig();

    await pool.query(
      `INSERT INTO contracts (chain_id, address, event_name, event_signature, topic0)
       VALUES ($1, $2, $3, $4, $5)`,
      [config.contracts[0]?.chainId, config.contracts[0]?.address, 'Transfer', 'sig', 'topic'],
    );

    await expect(
      pool.query(
        `INSERT INTO contracts (chain_id, address, event_name, event_signature, topic0)
         VALUES ($1, $2, $3, $4, $5)`,
        [config.contracts[0]?.chainId, config.contracts[0]?.address, 'Transfer', 'sig', 'topic'],
      ),
    ).rejects.toThrow(/duplicate key value/);
  });

  it('enforces the unique event identity (chain_id, tx_hash, log_index)', async () => {
    const config = buildTestConfig();
    const log = makeTransferLog({ txHashSeed: 'aa', blockNumber: 100n, logIndex: 0 }) as RawLog;
    const { contracts } = await seedEvents(pool, config, [log]);
    const contract = requireContract(contracts, config.contracts[0]!);

    const duplicate: EventInsertRow = {
      chainId: '1',
      contractId: contract.id,
      txHash: log.transactionHash ?? '',
      logIndex: '0',
      blockNumber: '100',
      blockHash: log.blockHash ?? '',
      txIndex: '0',
      eventName: 'Transfer',
      args: { from: '0x1', to: '0x2', value: '1' },
      rawTopics: [...log.topics],
      data: log.data,
    };

    const result = await withTransaction(pool, (tx) => insertEventBatch(tx, [duplicate]));
    expect(result.inserted).toBe(0);
    expect(result.conflicts).toBe(1);

    const count = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM event_logs');
    expect(count.rows[0]?.count).toBe('1');
  });

  it('cascades contract deletion to events and state', async () => {
    const config = buildTestConfig({ startBlock: '10' });
    const { contracts } = await seedEvents(pool, config, [
      makeTransferLog({ txHashSeed: 'bb', blockNumber: 12n, logIndex: 1 }) as RawLog,
    ]);
    const contract = requireContract(contracts, config.contracts[0]!);

    await pool.query('INSERT INTO ingestion_state (contract_id, last_finalized_block) VALUES ($1, 12)', [contract.id]);
    await pool.query('DELETE FROM contracts WHERE id = $1', [contract.id]);

    const events = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM event_logs');
    const states = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM ingestion_state');
    expect(events.rows[0]?.count).toBe('0');
    expect(states.rows[0]?.count).toBe('0');
  });

  it('accepts the -1 cursor sentinel used for startBlock 0', async () => {
    const config = buildTestConfig();
    const contracts = await seedEvents(pool, config, []);
    const contract = requireContract(contracts.contracts, config.contracts[0]!);

    const row = await pool.query<{ last_finalized_block: string }>(
      `INSERT INTO ingestion_state (contract_id, last_finalized_block) VALUES ($1, -1)
       RETURNING last_finalized_block`,
      [contract.id],
    );
    expect(row.rows[0]?.last_finalized_block).toBe('-1');
  });
});
