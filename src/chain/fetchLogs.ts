import type { Logger } from 'pino';
import { describeError } from '../utils/errors';
import { collectErrorFacts, retry, type RetryOptions } from '../utils/retry';
import type { ChainClientLike, RawLog } from '../types';

/**
 * `eth_getLogs` fetching with range splitting, retry and adaptive shrinking.
 *
 * Public providers cap how many blocks (or how many matching logs) a single
 * `eth_getLogs` call may cover and fail with a provider-specific error when the
 * cap is exceeded. Instead of giving up, the requested range is halved and the
 * call is retried from the same cursor.
 */

export interface FetchLogsParams {
  chainId: string;
  address: string;
  topic0: string;
  fromBlock: bigint;
  toBlock: bigint;
  maxBlockRange: number;
}

export interface FetchLogsDependencies {
  logger?: Logger;
  retryOptions?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface FetchLogsResult {
  logs: RawLog[];
  rangesRequested: number;
  effectiveMaxRange: number;
  rangeReduced: boolean;
}

const RANGE_LIMIT_PATTERNS: RegExp[] = [
  /query (exceeds|returned more than)/i,
  /range is too (large|wide)/i,
  /exceeds (the )?(max|maximum)?\s*(block )?range/i,
  /response size exceeded/i,
  /limit exceeded/i,
  /more than \d+ (results|logs|blocks)/i,
  /too many (results|logs|blocks)/i,
  /log response size/i,
];

const RANGE_LIMIT_CODES = new Set(['-32005', '-32007']);

/** Heuristic (documented in docs/DECISIONS.md) for "shrink the range" errors. */
export function isRangeTooLargeError(error: unknown): boolean {
  const facts = collectErrorFacts(error);
  if (facts.codes.some((code) => RANGE_LIMIT_CODES.has(code))) return true;
  return RANGE_LIMIT_PATTERNS.some((pattern) =>
    facts.messages.some((message) => pattern.test(message)),
  );
}

export async function fetchLogs(
  params: FetchLogsParams,
  client: ChainClientLike,
  dependencies: FetchLogsDependencies = {},
): Promise<FetchLogsResult> {
  const logs: RawLog[] = [];
  if (params.fromBlock > params.toBlock) {
    return { logs, rangesRequested: 0, effectiveMaxRange: params.maxBlockRange, rangeReduced: false };
  }

  let rangeSize = BigInt(Math.max(1, Math.floor(params.maxBlockRange)));
  let rangesRequested = 0;
  let rangeReduced = false;
  let cursor = params.fromBlock;

  while (cursor <= params.toBlock) {
    const candidateEnd = cursor + rangeSize - 1n;
    const rangeEnd = candidateEnd > params.toBlock ? params.toBlock : candidateEnd;

    try {
      const batch = await retry(
        () =>
          client.getLogs({
            address: params.address,
            topics: [params.topic0],
            fromBlock: cursor,
            toBlock: rangeEnd,
          }),
        dependencies.retryOptions ?? {},
        { sleep: dependencies.sleep, random: dependencies.random },
      );
      rangesRequested += 1;
      for (const log of batch) {
        logs.push(log);
      }
      cursor = rangeEnd + 1n;
    } catch (error) {
      if (isRangeTooLargeError(error) && rangeSize > 1n) {
        const nextRangeSize = rangeSize / 2n;
        dependencies.logger?.warn(
          {
            chainId: params.chainId,
            address: params.address,
            fromBlock: cursor.toString(),
            rangeSize: rangeSize.toString(),
            nextRangeSize: nextRangeSize.toString(),
            error: describeError(error),
          },
          'log range rejected by the provider, halving the range and retrying',
        );
        rangeSize = nextRangeSize < 1n ? 1n : nextRangeSize;
        rangeReduced = true;
        continue;
      }
      throw error;
    }
  }

  return {
    logs,
    rangesRequested,
    effectiveMaxRange: Number(rangeSize),
    rangeReduced,
  };
}
