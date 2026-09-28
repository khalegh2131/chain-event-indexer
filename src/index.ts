import { bootstrap, type BootstrapHandle } from './bootstrap';
import { describeError } from './utils/errors';
import { createLogger } from './utils/logger';

/**
 * Process entry point.
 *
 * Runs the real bootstrap (config -> database -> migrations -> HTTP -> poller)
 * when executed directly, and behaves as a library module when imported.
 */

export async function main(): Promise<BootstrapHandle> {
  return bootstrap();
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const logger = createLogger();
    logger.fatal(
      {
        error: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'startup failed',
    );
    process.exitCode = 1;
    // Give pino a tick to flush the fatal log before the process exits.
    setTimeout(() => process.exit(1), 10);
  });
}

export { buildApp, type BuildAppOptions, type BuiltApp } from './app';
export { bootstrap, type BootstrapHandle, type BootstrapOptions } from './bootstrap';
export { createPoller, type Poller } from './chain/poller';
export { runPollCycle, type IngestDependencies, type PollCycleResult } from './chain/ingest';
export { loadConfig, buildConfig, type LoadedConfig } from './config/load';
export { createMetrics, type Metrics } from './metrics/metrics';
export { ChainEventIndexerClient, ChainEventIndexerError } from './client';
export type * from './types';
