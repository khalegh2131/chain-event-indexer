import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics.
 *
 * Label cardinality is deliberately bounded: chain id, contract address and
 * event name come from configuration. Transaction hashes and block numbers are
 * never used as labels.
 */

export interface Metrics {
  readonly registry: Registry;
  readonly contentType: string;
  incPollSuccess(chainId: string): void;
  incPollError(chainId: string): void;
  addEventsInserted(chainId: string, eventName: string, count: number): void;
  addEventsConflict(chainId: string, eventName: string, count: number): void;
  observePollDuration(chainId: string, seconds: number): void;
  setLastIndexedBlock(chainId: string, contractAddress: string, block: string): void;
  setTargetBlock(chainId: string, block: string): void;
  render(): Promise<string>;
  reset(): void;
}

export interface CreateMetricsOptions {
  /** Disable process/runtime default metrics (useful in unit tests). */
  collectDefaultMetrics?: boolean;
  serviceName?: string;
}

/**
 * Prometheus stores samples as float64, so an EVM block number is converted to
 * a JavaScript number. Real block heights (< 1e9) are exact; a value beyond
 * 2^53 would lose precision at scrape time regardless of how it is sent.
 */
function toGaugeNumber(value: string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function createMetrics(options: CreateMetricsOptions = {}): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: options.serviceName ?? 'chain-event-indexer' });

  if (options.collectDefaultMetrics !== false) {
    collectDefaultMetrics({ register: registry });
  }

  const pollSuccess = new Counter({
    name: 'indexer_poll_success_total',
    help: 'Number of completed poll cycles per chain.',
    labelNames: ['chain_id'],
    registers: [registry],
  });

  const pollError = new Counter({
    name: 'indexer_poll_error_total',
    help: 'Number of failed poll operations per chain.',
    labelNames: ['chain_id'],
    registers: [registry],
  });

  const eventsInserted = new Counter({
    name: 'indexer_events_inserted_total',
    help: 'Number of event rows inserted into the database.',
    labelNames: ['chain_id', 'event_name'],
    registers: [registry],
  });

  const eventsConflict = new Counter({
    name: 'indexer_events_conflict_total',
    help: 'Number of event rows skipped because they already existed.',
    labelNames: ['chain_id', 'event_name'],
    registers: [registry],
  });

  const lastIndexedBlock = new Gauge({
    name: 'indexer_last_indexed_block',
    help: 'Highest finalized block persisted for a contract.',
    labelNames: ['chain_id', 'contract_address'],
    registers: [registry],
  });

  const targetBlock = new Gauge({
    name: 'indexer_target_block',
    help: 'Highest processable block (latest - confirmations) per chain.',
    labelNames: ['chain_id'],
    registers: [registry],
  });

  const pollDuration = new Histogram({
    name: 'indexer_poll_duration_seconds',
    help: 'Duration of a poll cycle per chain.',
    labelNames: ['chain_id'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  return {
    registry,
    contentType: registry.contentType,
    incPollSuccess: (chainId) => {
      pollSuccess.inc({ chain_id: chainId });
    },
    incPollError: (chainId) => {
      pollError.inc({ chain_id: chainId });
    },
    addEventsInserted: (chainId, eventName, count) => {
      if (count <= 0) return;
      eventsInserted.inc({ chain_id: chainId, event_name: eventName }, count);
    },
    addEventsConflict: (chainId, eventName, count) => {
      if (count <= 0) return;
      eventsConflict.inc({ chain_id: chainId, event_name: eventName }, count);
    },
    observePollDuration: (chainId, seconds) => {
      pollDuration.observe({ chain_id: chainId }, seconds);
    },
    setLastIndexedBlock: (chainId, contractAddress, block) => {
      lastIndexedBlock.set(
        { chain_id: chainId, contract_address: contractAddress },
        toGaugeNumber(block),
      );
    },
    setTargetBlock: (chainId, block) => {
      targetBlock.set({ chain_id: chainId }, toGaugeNumber(block));
    },
    render: () => registry.metrics(),
    reset: () => registry.resetMetrics(),
  };
}
