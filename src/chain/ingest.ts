import type { Logger } from 'pino';
import { contractKey, contractsForChain } from '../config/normalize';
import { withTransaction, type PoolLike } from '../db/client';
import { insertEventBatch } from '../db/repositories/events';
import { getIngestionState, upsertIngestionState } from '../db/repositories/state';
import type { Metrics } from '../metrics/metrics';
import { describeError } from '../utils/errors';
import { compareDecimalStrings } from '../utils/numbers';
import { retry, type RetryOptions } from '../utils/retry';
import type {
  ChainClientLike,
  EventInsertRow,
  NormalizedChain,
  NormalizedConfig,
  NormalizedContract,
  RawLog,
  RegisteredContract,
  RegisteredContractMap,
} from '../types';
import { decodeLog } from './decoder';
import { fetchLogs } from './fetchLogs';
import type { PollerStatusStore } from './status';

/**
 * The ingestion engine.
 *
 * One `runPollCycle` call walks every configured chain, reads the finalized
 * head (`latest - confirmations`), and advances each contract's cursor in
 * `maxBlockRange` sized chunks. Every chunk is committed atomically together
 * with its cursor update, which makes the pipeline idempotent, restart-safe and
 * safe to run from more than one replica (the unique constraint arbitrates).
 */

export interface IngestDependencies {
  pool: PoolLike;
  config: NormalizedConfig;
  contracts: RegisteredContractMap;
  clients: Map<string, ChainClientLike>;
  logger: Logger;
  metrics: Metrics;
  status: PollerStatusStore;
  retryOptions?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Safety valve: maximum chunks committed per contract per cycle. */
  maxBatchesPerContract?: number;
  /** Restrict the cycle to a subset of chains (used by the per-chain poller). */
  filterChainIds?: readonly string[];
}

export interface ContractCycleResult {
  chainId: string;
  address: string;
  eventName: string;
  fromBlock: string | null;
  toBlock: string | null;
  rangesProcessed: number;
  eventsInserted: number;
  eventsConflicted: number;
  skipped: boolean;
  error: string | null;
}

export interface ChainCycleResult {
  chainId: string;
  latestBlock: string | null;
  targetBlock: string | null;
  skipped: boolean;
  error: string | null;
  durationMs: number;
  contracts: ContractCycleResult[];
}

export interface PollCycleResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  eventsInserted: number;
  eventsConflicted: number;
  errors: number;
  chains: ChainCycleResult[];
}

const DEFAULT_MAX_BATCHES_PER_CONTRACT = 25;

function emptyContractResult(
  contract: NormalizedContract,
  chain: NormalizedChain,
): ContractCycleResult {
  return {
    chainId: chain.chainId,
    address: contract.address,
    eventName: contract.eventName,
    fromBlock: null,
    toBlock: null,
    rangesProcessed: 0,
    eventsInserted: 0,
    eventsConflicted: 0,
    skipped: false,
    error: null,
  };
}

function toEventRows(
  logs: readonly RawLog[],
  contract: NormalizedContract,
  registered: RegisteredContract,
): EventInsertRow[] {
  const rows: EventInsertRow[] = [];

  for (const log of logs) {
    const { blockNumber, logIndex, transactionHash } = log;
    if (blockNumber === null || logIndex === null || transactionHash === null) {
      throw new Error(
        `RPC returned an incomplete log for ${contract.address} (blockNumber, logIndex or transactionHash missing)`,
      );
    }
    const decoded = decodeLog(log, contract.abiItem);
    rows.push({
      chainId: contract.chainId,
      contractId: registered.id,
      txHash: transactionHash,
      logIndex: logIndex.toString(),
      blockNumber: blockNumber.toString(),
      blockHash: log.blockHash ?? '',
      txIndex: String(log.transactionIndex ?? 0),
      eventName: decoded.eventName,
      args: decoded.args,
      rawTopics: [...log.topics],
      data: log.data,
    });
  }

  rows.sort((left, right) => {
    const byBlock = compareDecimalStrings(left.blockNumber, right.blockNumber);
    if (byBlock !== 0) return byBlock;
    const byIndex = compareDecimalStrings(left.logIndex, right.logIndex);
    if (byIndex !== 0) return byIndex;
    if (left.txHash === right.txHash) return 0;
    return left.txHash < right.txHash ? -1 : 1;
  });

  return rows;
}

async function processContract(
  dependencies: IngestDependencies,
  chain: NormalizedChain,
  contract: NormalizedContract,
  registered: RegisteredContract,
  client: ChainClientLike,
  targetBlock: bigint,
): Promise<ContractCycleResult> {
  const result = emptyContractResult(contract, chain);

  try {
    let state = await getIngestionState(dependencies.pool, registered.id);

    if (state === null) {
      if (contract.startBlock !== null) {
        const startBlock = BigInt(contract.startBlock);
        const initialCursor = startBlock - 1n;
        state = await upsertIngestionState(
          dependencies.pool,
          registered.id,
          initialCursor.toString(),
        );
        dependencies.logger.info(
          {
            chainId: chain.chainId,
            address: contract.address,
            eventName: contract.eventName,
            startBlock: startBlock.toString(),
          },
          'initialized ingestion cursor from configured startBlock',
        );
      } else {
        // No startBlock: begin at the finalized head without backfilling.
        state = await upsertIngestionState(
          dependencies.pool,
          registered.id,
          targetBlock.toString(),
        );
        result.skipped = true;
        result.toBlock = targetBlock.toString();
        dependencies.status.setContractIndexed(registered.id, targetBlock.toString());
        dependencies.metrics.setLastIndexedBlock(
          chain.chainId,
          contract.address,
          targetBlock.toString(),
        );
        dependencies.logger.info(
          {
            chainId: chain.chainId,
            address: contract.address,
            eventName: contract.eventName,
            cursor: targetBlock.toString(),
          },
          'initialized ingestion cursor at the finalized head (no historical backfill)',
        );
        return result;
      }
    }

    const rawFromBlock = BigInt(state.lastFinalizedBlock) + 1n;
    const fromBlock = rawFromBlock < 0n ? 0n : rawFromBlock;
    result.fromBlock = fromBlock.toString();
    result.toBlock = targetBlock.toString();

    if (fromBlock > targetBlock) {
      result.skipped = true;
      return result;
    }

    const maxBatches = dependencies.maxBatchesPerContract ?? DEFAULT_MAX_BATCHES_PER_CONTRACT;
    const rangeSize = BigInt(Math.max(1, Math.floor(chain.maxBlockRange)));
    let cursor = fromBlock;
    let batches = 0;

    while (cursor <= targetBlock) {
      const candidateEnd = cursor + rangeSize - 1n;
      const rangeEnd = candidateEnd > targetBlock ? targetBlock : candidateEnd;

      const fetched = await fetchLogs(
        {
          chainId: chain.chainId,
          address: contract.address,
          topic0: contract.topic0,
          fromBlock: cursor,
          toBlock: rangeEnd,
          maxBlockRange: chain.maxBlockRange,
        },
        client,
        {
          logger: dependencies.logger,
          retryOptions: dependencies.retryOptions,
          sleep: dependencies.sleep,
          random: dependencies.random,
        },
      );

      const rows = toEventRows(fetched.logs, contract, registered);

      // Events and the cursor move together: either both are visible or neither.
      const { inserted, conflicts } = await withTransaction(dependencies.pool, async (tx) => {
        const insertResult = await insertEventBatch(tx, rows);
        await upsertIngestionState(tx, registered.id, rangeEnd.toString());
        return insertResult;
      });

      result.rangesProcessed += 1;
      result.eventsInserted += inserted;
      result.eventsConflicted += conflicts;

      dependencies.metrics.addEventsInserted(chain.chainId, contract.eventName, inserted);
      dependencies.metrics.addEventsConflict(chain.chainId, contract.eventName, conflicts);
      dependencies.metrics.setLastIndexedBlock(
        chain.chainId,
        contract.address,
        rangeEnd.toString(),
      );
      dependencies.status.setContractIndexed(registered.id, rangeEnd.toString());

      cursor = rangeEnd + 1n;
      batches += 1;

      if (batches >= maxBatches) {
        dependencies.logger.info(
          {
            chainId: chain.chainId,
            address: contract.address,
            cursor: cursor.toString(),
            targetBlock: targetBlock.toString(),
          },
          'per-cycle batch budget reached, continuing in the next cycle',
        );
        break;
      }
    }

    return result;
  } catch (error) {
    result.error = describeError(error);
    dependencies.logger.error(
      {
        chainId: chain.chainId,
        address: contract.address,
        eventName: contract.eventName,
        error: result.error,
      },
      'contract ingestion failed; the cursor stays at the last committed block',
    );
    return result;
  }
}

export async function runPollCycle(dependencies: IngestDependencies): Promise<PollCycleResult> {
  const startedAtMs = Date.now();
  const chains: ChainCycleResult[] = [];
  let eventsInserted = 0;
  let eventsConflicted = 0;
  let errors = 0;

  const filter = dependencies.filterChainIds ? new Set(dependencies.filterChainIds) : null;

  for (const chain of dependencies.config.chains) {
    if (filter && !filter.has(chain.chainId)) continue;

    const chainStartedAtMs = Date.now();
    const chainResult: ChainCycleResult = {
      chainId: chain.chainId,
      latestBlock: null,
      targetBlock: null,
      skipped: false,
      error: null,
      durationMs: 0,
      contracts: [],
    };

    const client = dependencies.clients.get(chain.chainId);
    if (!client) {
      chainResult.skipped = true;
      chainResult.error = `no RPC client configured for chain ${chain.chainId}`;
      dependencies.status.setChainError(chain.chainId, chainResult.error);
      dependencies.metrics.incPollError(chain.chainId);
      errors += 1;
      dependencies.logger.error({ chainId: chain.chainId }, chainResult.error);
      chainResult.durationMs = Date.now() - chainStartedAtMs;
      chains.push(chainResult);
      continue;
    }

    let latestBlock: bigint;
    try {
      latestBlock = await retry(
        () => client.getBlockNumber(),
        dependencies.retryOptions ?? {},
        { sleep: dependencies.sleep, random: dependencies.random },
      );
    } catch (error) {
      chainResult.skipped = true;
      chainResult.error = describeError(error);
      dependencies.status.setChainError(chain.chainId, chainResult.error);
      dependencies.metrics.incPollError(chain.chainId);
      errors += 1;
      dependencies.logger.error(
        { chainId: chain.chainId, error: chainResult.error },
        'failed to read the latest block number',
      );
      chainResult.durationMs = Date.now() - chainStartedAtMs;
      chains.push(chainResult);
      continue;
    }

    chainResult.latestBlock = latestBlock.toString();
    const targetBlock = latestBlock - BigInt(chain.confirmations);

    if (targetBlock < 0n) {
      chainResult.skipped = true;
      dependencies.status.setChainSkipped(chain.chainId, latestBlock.toString());
      dependencies.logger.debug(
        { chainId: chain.chainId, latestBlock: latestBlock.toString(), confirmations: chain.confirmations },
        'chain head is below the confirmations threshold, skipping',
      );
      chainResult.durationMs = Date.now() - chainStartedAtMs;
      chains.push(chainResult);
      continue;
    }

    chainResult.targetBlock = targetBlock.toString();
    dependencies.status.setChainPoll(chain.chainId, latestBlock.toString(), targetBlock.toString());
    dependencies.metrics.setTargetBlock(chain.chainId, targetBlock.toString());

    for (const contract of contractsForChain(dependencies.config, chain.chainId)) {
      const registered = dependencies.contracts.get(
        contractKey(contract.chainId, contract.address, contract.topic0),
      );
      if (!registered) {
        const missing = emptyContractResult(contract, chain);
        missing.error = `contract ${contract.address} (${contract.eventName}) is not registered in the database`;
        dependencies.logger.error(
          { chainId: chain.chainId, address: contract.address },
          missing.error,
        );
        errors += 1;
        chainResult.contracts.push(missing);
        continue;
      }

      const contractResult = await processContract(
        dependencies,
        chain,
        contract,
        registered,
        client,
        targetBlock,
      );
      chainResult.contracts.push(contractResult);
      eventsInserted += contractResult.eventsInserted;
      eventsConflicted += contractResult.eventsConflicted;
      if (contractResult.error !== null) errors += 1;
    }

    const chainFailed =
      chainResult.contracts.some((contractResult) => contractResult.error !== null);
    chainResult.durationMs = Date.now() - chainStartedAtMs;
    dependencies.metrics.observePollDuration(chain.chainId, chainResult.durationMs / 1000);

    if (chainFailed) {
      dependencies.metrics.incPollError(chain.chainId);
      dependencies.status.recordChainFailure(chain.chainId, chainResult.durationMs);
    } else {
      dependencies.metrics.incPollSuccess(chain.chainId);
      dependencies.status.recordChainSuccess(chain.chainId, chainResult.durationMs);
    }

    chains.push(chainResult);
  }

  const finishedAtMs = Date.now();
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    eventsInserted,
    eventsConflicted,
    errors,
    chains,
  };
}
