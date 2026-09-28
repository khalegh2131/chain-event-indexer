import { buildApp, type BuiltApp } from '../../src/app';
import { createPollerStatusStore } from '../../src/chain/status';
import { buildConfig } from '../../src/config/load';
import { contractKey } from '../../src/config/normalize';
import type { RawConfig } from '../../src/config/schema';
import { createDbClient, withTransaction, type PoolLike } from '../../src/db/client';
import { registerContracts } from '../../src/db/repositories/contracts';
import { insertEventBatch } from '../../src/db/repositories/events';
import { createMetrics } from '../../src/metrics/metrics';
import { decodeLog } from '../../src/chain/decoder';
import { createSilentLogger } from '../../src/utils/logger';
import type {
  ChainClientLike,
  EventInsertRow,
  GetLogsArgs,
  NormalizedConfig,
  NormalizedContract,
  RawLog,
  RegisteredContract,
  RegisteredContractMap,
} from '../../src/types';
import {
  ERC20_TRANSFER_SIGNATURE,
  SENDER_ADDRESS,
  RECIPIENT_ADDRESS,
  USDT_ADDRESS,
  padAddress,
} from '../unit/fixtures';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://indexer:indexer_password@localhost:5433/chain_event_indexer_test';

export const testLogger = createSilentLogger();

export function createTestPool(): PoolLike {
  return createDbClient({
    connectionString: TEST_DATABASE_URL,
    max: 4,
    applicationName: 'chain-event-indexer-test',
  });
}

export async function truncateAll(pool: PoolLike): Promise<void> {
  await pool.query(
    'TRUNCATE TABLE event_logs, ingestion_state, contracts RESTART IDENTITY CASCADE',
  );
}

export interface TestConfigOptions {
  startBlock?: string;
  confirmations?: number;
  maxBlockRange?: number;
  chainId?: string;
  address?: string;
}

export function buildTestConfig(options: TestConfigOptions = {}): NormalizedConfig {
  const chainId = options.chainId ?? '1';
  const chain: Record<string, unknown> = {
    chainId,
    rpcUrl: 'https://rpc.test.local',
    confirmations: options.confirmations ?? 2,
    pollIntervalMs: 1000,
    maxBlockRange: options.maxBlockRange ?? 10,
  };
  const contract: Record<string, unknown> = {
    chainId,
    address: options.address ?? USDT_ADDRESS,
    eventName: 'Transfer',
    eventSignature: ERC20_TRANSFER_SIGNATURE,
  };
  if (options.startBlock !== undefined) {
    contract['startBlock'] = options.startBlock;
  }

  const raw = { chains: [chain], contracts: [contract] } as unknown as RawConfig;
  return buildConfig(raw).config;
}

export function requireContract(
  contracts: RegisteredContractMap,
  contract: NormalizedContract,
): RegisteredContract {
  const registered = contracts.get(
    contractKey(contract.chainId, contract.address, contract.topic0),
  );
  if (!registered) {
    throw new Error(`contract ${contract.address} was not registered`);
  }
  return registered;
}

export interface SeedResult {
  contracts: RegisteredContractMap;
  rows: EventInsertRow[];
}

/** Registers the configured contracts and inserts the supplied logs. */
export async function seedEvents(
  pool: PoolLike,
  config: NormalizedConfig,
  logs: readonly RawLog[],
): Promise<SeedResult> {
  const contracts = await registerContracts(pool, config.contracts);
  const rows: EventInsertRow[] = [];

  for (const log of logs) {
    const contract = config.contracts[0];
    if (!contract) throw new Error('test config has no contract');
    const registered = requireContract(contracts, contract);
    const decoded = decodeLog(log, contract.abiItem);
    rows.push({
      chainId: contract.chainId,
      contractId: registered.id,
      txHash: log.transactionHash ?? `0x${'00'.repeat(32)}`,
      logIndex: String(log.logIndex ?? 0),
      blockNumber: String(log.blockNumber ?? 0n),
      blockHash: log.blockHash ?? `0x${'11'.repeat(32)}`,
      txIndex: String(log.transactionIndex ?? 0),
      eventName: decoded.eventName,
      args: decoded.args,
      rawTopics: [...log.topics],
      data: log.data,
    });
  }

  if (rows.length > 0) {
    await withTransaction(pool, (tx) => insertEventBatch(tx, rows));
  }

  return { contracts, rows };
}

export interface TestAppOptions {
  config?: NormalizedConfig;
  pool: PoolLike;
  apiKey?: string | null;
  clients?: Map<string, ChainClientLike>;
  contracts?: RegisteredContractMap;
  registerDocs?: boolean;
}

export interface TestApp {
  built: BuiltApp;
  pool: PoolLike;
}

/** Builds the real application with the poller switched off. */
export async function buildTestApp(options: TestAppOptions): Promise<TestApp> {
  const built = await buildApp({
    config: options.config ?? buildTestConfig(),
    pool: options.pool,
    logger: testLogger,
    metrics: createMetrics({ collectDefaultMetrics: false }),
    status: createPollerStatusStore(),
    apiKey: options.apiKey ?? null,
    clients: options.clients ?? new Map<string, ChainClientLike>(),
    contracts: options.contracts,
    startPoller: false,
    registerDocs: options.registerDocs ?? true,
  });

  return { built, pool: options.pool };
}

export interface SequenceLogOptions {
  txHashSeed: string;
  blockNumber: bigint;
  logIndex: number;
  value?: bigint;
  from?: string;
  to?: string;
  address?: string;
  blockHashSeed?: string;
  transactionIndex?: number;
}

export function makeTransferLog(options: SequenceLogOptions): RawLog {
  const value = options.value ?? 1_000_000n;
  return {
    address: options.address ?? USDT_ADDRESS,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      padAddress(options.from ?? SENDER_ADDRESS),
      padAddress(options.to ?? RECIPIENT_ADDRESS),
    ],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    blockNumber: options.blockNumber,
    blockHash: `0x${(options.blockHashSeed ?? 'ab').repeat(32).slice(0, 64)}`,
    transactionHash: `0x${options.txHashSeed.repeat(32).slice(0, 64)}`,
    transactionIndex: options.transactionIndex ?? 0,
    logIndex: options.logIndex,
    removed: false,
  };
}

export function makeLogs(
  startBlock: bigint,
  count: number,
  seed = 'cd',
): RawLog[] {
  const logs: RawLog[] = [];
  for (let index = 0; index < count; index += 1) {
    logs.push(
      makeTransferLog({
        txHashSeed: `${seed}${index.toString(16).padStart(2, '0')}`,
        blockNumber: startBlock + BigInt(index),
        logIndex: index,
        value: BigInt(1000 + index),
      }),
    );
  }
  return logs;
}

export const APPROVAL_SIGNATURE =
  'event Approval(address indexed owner, address indexed spender, uint256 value)';

/** keccak256('Approval(address,address,uint256)') */
export const APPROVAL_TOPIC0 =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

/** Two contracts on the same address: Transfer and Approval. */
export function buildTwoContractConfig(options: TestConfigOptions = {}): NormalizedConfig {
  const chainId = options.chainId ?? '1';
  const address = options.address ?? USDT_ADDRESS;
  const chain: Record<string, unknown> = {
    chainId,
    rpcUrl: 'https://rpc.test.local',
    confirmations: options.confirmations ?? 2,
    pollIntervalMs: 1000,
    maxBlockRange: options.maxBlockRange ?? 10,
  };
  const transfer: Record<string, unknown> = {
    chainId,
    address,
    eventName: 'Transfer',
    eventSignature: ERC20_TRANSFER_SIGNATURE,
  };
  const approval: Record<string, unknown> = {
    chainId,
    address,
    eventName: 'Approval',
    eventSignature: APPROVAL_SIGNATURE,
  };
  if (options.startBlock !== undefined) {
    transfer['startBlock'] = options.startBlock;
    approval['startBlock'] = options.startBlock;
  }

  const raw = { chains: [chain], contracts: [transfer, approval] } as unknown as RawConfig;
  return buildConfig(raw).config;
}

export function makeApprovalLog(options: SequenceLogOptions): RawLog {
  const value = options.value ?? 500n;
  return {
    address: options.address ?? USDT_ADDRESS,
    topics: [
      APPROVAL_TOPIC0,
      padAddress(options.from ?? SENDER_ADDRESS),
      padAddress(options.to ?? RECIPIENT_ADDRESS),
    ],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    blockNumber: options.blockNumber,
    blockHash: `0x${(options.blockHashSeed ?? 'ab').repeat(32).slice(0, 64)}`,
    transactionHash: `0x${options.txHashSeed.repeat(32).slice(0, 64)}`,
    transactionIndex: options.transactionIndex ?? 0,
    logIndex: options.logIndex,
    removed: false,
  };
}

/** Deterministic, network-free replacement for a viem public client. */
export class FakeChainClient implements ChainClientLike {
  blockNumberCalls = 0;
  logCalls: GetLogsArgs[] = [];
  private latestBlock: bigint;
  private logs: RawLog[];
  private failures: number;

  constructor(options: { latestBlock: bigint; logs?: RawLog[]; failures?: number }) {
    this.latestBlock = options.latestBlock;
    this.logs = options.logs ?? [];
    this.failures = options.failures ?? 0;
  }

  setLatestBlock(value: bigint): void {
    this.latestBlock = value;
  }

  setLogs(logs: RawLog[]): void {
    this.logs = logs;
  }

  async getBlockNumber(): Promise<bigint> {
    this.blockNumberCalls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    }
    return this.latestBlock;
  }

  async getLogs(args: GetLogsArgs): Promise<RawLog[]> {
    this.logCalls.push(args);
    const requestedTopic0 = args.topics[0]?.toLowerCase();
    return this.logs.filter((log) => {
      if (log.blockNumber === null) return false;
      if (log.address.toLowerCase() !== args.address.toLowerCase()) return false;
      if (requestedTopic0 !== undefined && (log.topics[0] ?? '').toLowerCase() !== requestedTopic0) {
        return false;
      }
      return log.blockNumber >= args.fromBlock && log.blockNumber <= args.toBlock;
    });
  }
}
