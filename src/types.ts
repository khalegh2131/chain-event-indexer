import type { AbiEvent } from 'viem';

/**
 * Shared types for the chain event indexer.
 *
 * Everything in this module is type-only at runtime, so it is safe to import
 * from the browser-free `src/client` SDK without pulling in server code.
 */

/* ------------------------------------------------------------------ config */

export interface NormalizedChain {
  readonly chainId: string;
  readonly rpcUrl: string;
  readonly confirmations: number;
  readonly pollIntervalMs: number;
  readonly maxBlockRange: number;
}

export interface NormalizedContract {
  readonly chainId: string;
  readonly address: string;
  readonly eventName: string;
  readonly eventSignature: string;
  readonly topic0: string;
  readonly startBlock: string | null;
  readonly abiItem: AbiEvent;
}

export interface NormalizedConfig {
  readonly chains: readonly NormalizedChain[];
  readonly contracts: readonly NormalizedContract[];
}

/* ------------------------------------------------------------------- chain */

/** Minimal structural shape of an EVM log as returned by `eth_getLogs`. */
export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: bigint | null;
  blockHash: string | null;
  transactionHash: string | null;
  transactionIndex: number | null;
  logIndex: number | null;
  removed?: boolean | undefined;
}

export interface GetLogsArgs {
  address: string;
  topics: string[];
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * The subset of a viem public client the indexer depends on.
 * Keeping it structural makes the ingestion pipeline trivially mockable.
 */
export interface ChainClientLike {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: GetLogsArgs): Promise<RawLog[]>;
}

/* ---------------------------------------------------------------- database */

export interface RegisteredContract {
  id: string;
  chainId: string;
  address: string;
  eventName: string;
  eventSignature: string;
  topic0: string;
  startBlock: string | null;
  active: boolean;
}

/** Keyed by `contractKey(chainId, address, eventSignature)`. */
export type RegisteredContractMap = Map<string, RegisteredContract>;

export interface EventInsertRow {
  chainId: string;
  contractId: string;
  txHash: string;
  logIndex: string;
  blockNumber: string;
  blockHash: string;
  txIndex: string;
  eventName: string;
  args: unknown;
  rawTopics: string[];
  data: string;
}

/* ------------------------------------------------------------------ API DTO */

export interface EventItem {
  id: string;
  chainId: string;
  contractAddress: string;
  eventName: string;
  txHash: string;
  logIndex: string;
  blockNumber: string;
  blockHash: string;
  transactionIndex: string;
  args: unknown;
  rawTopics: string[];
  data: string;
  indexedAt: string;
}

export interface EventsResponse {
  items: EventItem[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: {
    message: string;
    code: string;
  };
}

export interface HealthResponse {
  status: 'ok' | 'error';
  db: 'up' | 'down';
  error?: {
    message: string;
    code: string;
  };
}

export interface ChainStatusSummary {
  chainId: string;
  latestBlock: string | null;
  targetBlock: string | null;
  lastPollAt: string | null;
  lastPollOkAt: string | null;
  lastError: string | null;
}

export interface ContractStatusSummary {
  chainId: string;
  address: string;
  eventName: string;
  lastIndexedBlock: string | null;
  targetBlock: string | null;
  lag: string | null;
}

export interface StatusResponse {
  uptimeSeconds: number;
  startedAt: string;
  pollerEnabled: boolean;
  pollerRunning: boolean;
  chains: ChainStatusSummary[];
  contracts: ContractStatusSummary[];
}

export interface GetEventsParams {
  chainId?: string;
  address?: string;
  eventName?: string;
  fromBlock?: string;
  toBlock?: string;
  txHash?: string;
  cursor?: string;
  limit?: number;
}
