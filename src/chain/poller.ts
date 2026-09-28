import type { Logger } from 'pino';
import { describeError } from '../utils/errors';
import { KeyedMutex } from '../utils/mutex';
import type { Metrics } from '../metrics/metrics';
import type {
  ChainClientLike,
  NormalizedConfig,
  RegisteredContractMap,
} from '../types';
import type { PoolLike } from '../db/client';
import type { RetryOptions } from '../utils/retry';
import { runPollCycle, type PollCycleResult } from './ingest';
import type { PollerStatusStore } from './status';

/**
 * Shell / orchestration around the ingestion engine.
 *
 * - one interval per chain, so a slow chain never blocks a fast one
 * - a per-chain mutex: an over-running cycle is skipped, never queued
 * - `runOnce()` and `runChain()` exist so tests can drive the pipeline
 *   deterministically without timers
 */

export interface CreatePollerOptions {
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
  maxBatchesPerContract?: number;
  /** Grace period for in-flight cycles during `stop()`. Defaults to 10s. */
  shutdownTimeoutMs?: number;
  /** Run the first cycle immediately instead of waiting one interval. */
  runImmediately?: boolean;
}

export interface Poller {
  readonly status: PollerStatusStore;
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  isChainBusy(chainId: string): boolean;
  runOnce(): Promise<PollCycleResult>;
  runChain(chainId: string): Promise<PollCycleResult | null>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function createPoller(options: CreatePollerOptions): Poller {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const runImmediately = options.runImmediately ?? true;
  const mutex = new KeyedMutex();
  const timers = new Map<string, NodeJS.Timeout>();
  const initialTimers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<Promise<unknown>>();
  let running = false;
  let stopping = false;

  const cycleDependencies = {
    pool: options.pool,
    config: options.config,
    contracts: options.contracts,
    clients: options.clients,
    logger: options.logger,
    metrics: options.metrics,
    status: options.status,
    retryOptions: options.retryOptions,
    sleep: options.sleep,
    random: options.random,
    maxBatchesPerContract: options.maxBatchesPerContract,
  };

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise);
    void promise.finally(() => {
      inFlight.delete(promise);
    });
    return promise;
  };

  const tick = (chainId: string): Promise<PollCycleResult | null> =>
    track(
      mutex
        .tryRunExclusive(chainId, () =>
          runPollCycle({ ...cycleDependencies, filterChainIds: [chainId] }),
        )
        .then((outcome) => {
          if (!outcome.ran) {
            options.logger.warn(
              { chainId },
              'previous poll cycle for this chain is still running; skipping this tick',
            );
            return null;
          }
          const result = outcome.value;
          if (result) {
            options.logger.debug(
              {
                chainId,
                durationMs: result.durationMs,
                eventsInserted: result.eventsInserted,
                eventsConflicted: result.eventsConflicted,
                errors: result.errors,
              },
              'poll cycle finished',
            );
          }
          return result ?? null;
        })
        .catch((error: unknown) => {
          options.logger.error(
            { chainId, error: describeError(error) },
            'poll cycle crashed unexpectedly',
          );
          options.metrics.incPollError(chainId);
          return null;
        }),
    );

  const scheduleChain = (chainId: string, intervalMs: number): void => {
    if (timers.has(chainId) || initialTimers.has(chainId)) return;

    if (runImmediately) {
      const initial = setTimeout(() => {
        initialTimers.delete(chainId);
        void tick(chainId);
      }, 0);
      initialTimers.set(chainId, initial);
    }

    const interval = setInterval(() => {
      void tick(chainId);
    }, intervalMs);
    timers.set(chainId, interval);
  };

  const clearTimers = (): void => {
    for (const timer of timers.values()) {
      clearInterval(timer);
    }
    timers.clear();
    for (const timer of initialTimers.values()) {
      clearTimeout(timer);
    }
    initialTimers.clear();
  };

  return {
    status: options.status,

    start(): void {
      if (running || stopping) return;
      running = true;
      options.status.setRunning(true);
      for (const chain of options.config.chains) {
        scheduleChain(chain.chainId, chain.pollIntervalMs);
      }
      options.logger.info(
        { chains: options.config.chains.map((chain) => chain.chainId) },
        'poller started',
      );
    },

    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      clearTimers();

      const pending = [...inFlight];
      if (pending.length > 0) {
        const timeout = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, shutdownTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        });
        await Promise.race([Promise.allSettled(pending).then(() => undefined), timeout]);
      }

      running = false;
      options.status.setRunning(false);
      options.logger.info('poller stopped');
    },

    isRunning(): boolean {
      return running;
    },

    isChainBusy(chainId: string): boolean {
      return mutex.isLocked(chainId);
    },

    async runOnce(): Promise<PollCycleResult> {
      if (running) {
        throw new Error('Poller is already running; use runChain() for manual cycles');
      }
      return track(
        runPollCycle({
          ...cycleDependencies,
        }),
      );
    },

    async runChain(chainId: string): Promise<PollCycleResult | null> {
      return tick(chainId);
    },
  };
}
