import type { Queryable } from '../client';

/**
 * Ingestion cursor repository.
 *
 * `last_finalized_block` is the highest block whose logs have been fully
 * persisted for a contract. `-1` is a valid sentinel meaning "nothing has been
 * processed yet", which lets `startBlock: 0` be expressed exactly.
 */

export interface IngestionStateRow {
  contract_id: string;
  last_finalized_block: string;
  updated_at: Date | string;
}

export interface IngestionState {
  contractId: string;
  lastFinalizedBlock: string;
  updatedAt: string;
}

export function mapStateRow(row: IngestionStateRow): IngestionState {
  return {
    contractId: String(row.contract_id),
    lastFinalizedBlock: String(row.last_finalized_block),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export async function getIngestionState(
  db: Queryable,
  contractId: string,
): Promise<IngestionState | null> {
  const result = await db.query<IngestionStateRow>(
    `SELECT contract_id, last_finalized_block, updated_at
     FROM ingestion_state
     WHERE contract_id = $1::bigint`,
    [contractId],
  );
  const row = result.rows[0];
  return row ? mapStateRow(row) : null;
}

/**
 * Advances the cursor. `GREATEST` keeps progress monotonic even if two cycles
 * ever overlap, so the indexer can never move backwards.
 */
export async function upsertIngestionState(
  db: Queryable,
  contractId: string,
  lastFinalizedBlock: string,
): Promise<IngestionState> {
  const result = await db.query<IngestionStateRow>(
    `INSERT INTO ingestion_state (contract_id, last_finalized_block, updated_at)
     VALUES ($1::bigint, $2::numeric, NOW())
     ON CONFLICT (contract_id) DO UPDATE SET
       last_finalized_block = GREATEST(
         ingestion_state.last_finalized_block,
         EXCLUDED.last_finalized_block
       ),
       updated_at = NOW()
     RETURNING contract_id, last_finalized_block, updated_at`,
    [contractId, lastFinalizedBlock],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Failed to upsert ingestion state for contract ${contractId}`);
  }
  return mapStateRow(row);
}

export async function listIngestionStates(db: Queryable): Promise<IngestionState[]> {
  const result = await db.query<IngestionStateRow>(
    `SELECT contract_id, last_finalized_block, updated_at
     FROM ingestion_state
     ORDER BY contract_id ASC`,
  );
  return result.rows.map(mapStateRow);
}

export async function deleteIngestionState(db: Queryable, contractId: string): Promise<number> {
  const result = await db.query('DELETE FROM ingestion_state WHERE contract_id = $1::bigint', [
    contractId,
  ]);
  return result.rowCount ?? 0;
}
