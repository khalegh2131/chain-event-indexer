import { contractKey } from '../../config/normalize';
import type { RegisteredContract, RegisteredContractMap, NormalizedContract } from '../../types';
import type { Queryable } from '../client';

/**
 * Contract registration repository.
 *
 * Configuration is the source of truth: every startup upserts the configured
 * contracts so the database always matches the deployed config file.
 */

interface ContractRow {
  id: string;
  chain_id: string;
  address: string;
  event_name: string;
  event_signature: string;
  topic0: string;
  start_block: string | null;
  active: boolean;
}

const UPSERT_CONTRACT = `
  INSERT INTO contracts (chain_id, address, event_name, event_signature, topic0, start_block, active)
  VALUES ($1::numeric, $2, $3, $4, $5, $6::numeric, TRUE)
  ON CONFLICT (chain_id, address, event_signature)
  DO UPDATE SET
    event_name = EXCLUDED.event_name,
    topic0 = EXCLUDED.topic0,
    start_block = COALESCE(EXCLUDED.start_block, contracts.start_block),
    active = TRUE,
    updated_at = NOW()
  RETURNING id, chain_id, address, event_name, event_signature, topic0, start_block, active
`;

const SELECT_CONTRACTS = `
  SELECT id, chain_id, address, event_name, event_signature, topic0, start_block, active
  FROM contracts
  WHERE active = TRUE
  ORDER BY chain_id ASC, address ASC, event_signature ASC
`;

export function mapContractRow(row: ContractRow): RegisteredContract {
  return {
    id: String(row.id),
    chainId: String(row.chain_id),
    address: row.address,
    eventName: row.event_name,
    eventSignature: row.event_signature,
    topic0: row.topic0,
    startBlock: row.start_block === null ? null : String(row.start_block),
    active: row.active,
  };
}

export async function upsertContract(
  db: Queryable,
  contract: NormalizedContract,
): Promise<RegisteredContract> {
  const result = await db.query<ContractRow>(UPSERT_CONTRACT, [
    contract.chainId,
    contract.address,
    contract.eventName,
    contract.eventSignature,
    contract.topic0,
    contract.startBlock,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Failed to register contract ${contract.address} (${contract.eventName})`);
  }
  return mapContractRow(row);
}

export async function registerContracts(
  db: Queryable,
  contracts: readonly NormalizedContract[],
): Promise<RegisteredContractMap> {
  const map: RegisteredContractMap = new Map();
  for (const contract of contracts) {
    const registered = await upsertContract(db, contract);
    map.set(contractKey(contract.chainId, contract.address, contract.topic0), registered);
  }
  return map;
}

export async function listContracts(db: Queryable): Promise<RegisteredContract[]> {
  const result = await db.query<ContractRow>(SELECT_CONTRACTS);
  return result.rows.map(mapContractRow);
}

export async function findContractById(
  db: Queryable,
  id: string,
): Promise<RegisteredContract | null> {
  const result = await db.query<ContractRow>(
    `SELECT id, chain_id, address, event_name, event_signature, topic0, start_block, active
     FROM contracts WHERE id = $1::bigint`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapContractRow(row) : null;
}
