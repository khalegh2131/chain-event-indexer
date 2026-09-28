import { stringifyJsonSafe } from '../../utils/json';
import type { EventInsertRow, EventItem } from '../../types';
import type { Queryable } from '../client';

/**
 * Event log repository.
 *
 * Writes are strictly idempotent: the natural key of an EVM log is
 * `(chain_id, tx_hash, log_index)` and conflicts are ignored rather than
 * updated, because a log is immutable once finalized.
 */

/** Rows per INSERT statement; 11 bind parameters each keeps us far below 65535. */
const INSERT_BATCH_SIZE = 500;
const COLUMNS_PER_ROW = 11;

export interface EventDbRow {
  id: string;
  chain_id: string;
  contract_address: string;
  event_name: string;
  tx_hash: string;
  log_index: string;
  block_number: string;
  block_hash: string;
  tx_index: string;
  args: unknown;
  raw_topics: string[];
  data: string;
  indexed_at: Date | string;
}

export interface InsertEventsResult {
  inserted: number;
  conflicts: number;
}

export interface EventQueryFilter {
  chainId?: string | undefined;
  address?: string | undefined;
  eventName?: string | undefined;
  fromBlock?: string | undefined;
  toBlock?: string | undefined;
  txHash?: string | undefined;
  cursorId?: string | undefined;
  limit: number;
}

export async function insertEventBatch(
  db: Queryable,
  rows: readonly EventInsertRow[],
): Promise<InsertEventsResult> {
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    if (chunk.length === 0) continue;

    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (const [index, row] of chunk.entries()) {
      const base = index * COLUMNS_PER_ROW;
      placeholders.push(
        `($${base + 1}::numeric, $${base + 2}::bigint, $${base + 3}, $${base + 4}::numeric, ` +
          `$${base + 5}::numeric, $${base + 6}, $${base + 7}::numeric, $${base + 8}, ` +
          `$${base + 9}::jsonb, $${base + 10}::text[], $${base + 11})`,
      );
      values.push(
        row.chainId,
        row.contractId,
        row.txHash,
        row.logIndex,
        row.blockNumber,
        row.blockHash,
        row.txIndex,
        row.eventName,
        stringifyJsonSafe(row.args),
        row.rawTopics,
        row.data,
      );
    }

    const sql =
      'INSERT INTO event_logs (chain_id, contract_id, tx_hash, log_index, block_number, ' +
      'block_hash, tx_index, event_name, args, raw_topics, data) VALUES ' +
      placeholders.join(', ') +
      ' ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING';

    const result = await db.query(sql, values);
    inserted += result.rowCount ?? 0;
  }

  return { inserted, conflicts: rows.length - inserted };
}

export async function queryEvents(db: Queryable, filter: EventQueryFilter): Promise<EventDbRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  const addCondition = (clause: (position: number) => string, value: unknown): void => {
    values.push(value);
    conditions.push(clause(values.length));
  };

  if (filter.chainId !== undefined) {
    addCondition((position) => `e.chain_id = $${position}::numeric`, filter.chainId);
  }
  if (filter.address !== undefined) {
    addCondition((position) => `c.address = $${position}`, filter.address);
  }
  if (filter.eventName !== undefined) {
    addCondition((position) => `e.event_name = $${position}`, filter.eventName);
  }
  if (filter.fromBlock !== undefined) {
    addCondition((position) => `e.block_number >= $${position}::numeric`, filter.fromBlock);
  }
  if (filter.toBlock !== undefined) {
    addCondition((position) => `e.block_number <= $${position}::numeric`, filter.toBlock);
  }
  if (filter.txHash !== undefined) {
    addCondition((position) => `LOWER(e.tx_hash) = $${position}`, filter.txHash.toLowerCase());
  }
  if (filter.cursorId !== undefined) {
    addCondition((position) => `e.id > $${position}::bigint`, filter.cursorId);
  }

  values.push(filter.limit + 1);
  const limitPosition = values.length;
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      e.id,
      e.chain_id,
      c.address AS contract_address,
      e.event_name,
      e.tx_hash,
      e.log_index,
      e.block_number,
      e.block_hash,
      e.tx_index,
      e.args,
      e.raw_topics,
      e.data,
      e.indexed_at
    FROM event_logs e
    INNER JOIN contracts c ON c.id = e.contract_id
    ${whereClause}
    ORDER BY e.block_number ASC, e.log_index ASC, e.id ASC
    LIMIT $${limitPosition}::int
  `;

  const result = await db.query<EventDbRow>(sql, values);
  return result.rows;
}

export function mapEventRow(row: EventDbRow): EventItem {
  return {
    id: String(row.id),
    chainId: String(row.chain_id),
    contractAddress: row.contract_address,
    eventName: row.event_name,
    txHash: row.tx_hash,
    logIndex: String(row.log_index),
    blockNumber: String(row.block_number),
    blockHash: row.block_hash,
    transactionIndex: String(row.tx_index),
    args: row.args ?? {},
    rawTopics: Array.isArray(row.raw_topics) ? row.raw_topics.map((topic) => String(topic)) : [],
    data: row.data,
    indexedAt:
      row.indexed_at instanceof Date ? row.indexed_at.toISOString() : String(row.indexed_at),
  };
}

export async function countEventLogs(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM event_logs');
  const row = result.rows[0];
  return row ? Number(row.count) : 0;
}
