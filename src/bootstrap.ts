import path from 'node:path';
import type { Logger } from 'pino';
import { buildApp, type BuiltApp } from './app';
import { createChainClients } from './chain/client';
import { createPollerStatusStore } from './chain/status';
import { loadConfig, type LoadedConfig } from './config/load';
import { closePool, createDbClient, waitForDatabase } from './db/client';
import { defaultMigrationsDir, runMigrations } from './db/migrate';
import { registerContracts } from './db/repositories/contracts';
import { createMetrics } from './metrics/metrics';
import { loadEnvFile, parseBooleanEnv, parseIntegerEnv } from './utils/env';
import { describeError } from './utils/errors';
import { createLogger } from './utils/logger';

/**
 * Production bootstrap.
 *
 * Order matters:
 *   1. `.env` (without overriding the real environment)
 *   2. logger (so early failures are structured)
 *   3. configuration (fail fast on bad config)
 *   4. database reachability (retry for up to 30s, then exit non-zero)
 *   5. migrations
 *   6. contract registration
 *   7. HTTP server + poller
 *   8. graceful shutdown handlers
 */

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  logger?: Logger;
  /** Run pending migrations before serving. Defaults to true. */
  runMigrations?: boolean;
  /** Defaults to `POLLER_ENABLED` (true when unset). */
  startPoller?: boolean;
  /** Install SIGINT/SIGTERM handlers. Defaults to true. */
  installSignalHandlers?: boolean;
  /** Deadline for graceful shutdown before a forced exit. Defaults to 10s. */
  shutdownTimeoutMs?: number;
  /** How long to wait for PostgreSQL at startup. Defaults to 30s. */
  databaseConnectTimeoutMs?: number;
}

export interface BootstrapHandle {
  built: BuiltApp;
  config: LoadedConfig;
  logger: Logger;
  address: string;
  port: number;
  host: string;
  pollerEnabled: boolean;
  shutdown(reason?: string): Promise<void>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_DB_CONNECT_TIMEOUT_MS = 30_000;

export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapHandle> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  // 1. .env is loaded first but never overrides the real environment.
  const envFilePath = path.isAbsolute(env['ENV_FILE'] ?? '')
    ? (env['ENV_FILE'] as string)
    : path.resolve(cwd, env['ENV_FILE'] ?? '.env');
  loadEnvFile(envFilePath, env);

  // 2. Logger.
  const logger = options.logger ?? createLogger({ level: env['LOG_LEVEL'] });

  let pool: ReturnType<typeof createDbClient> | null = null;
  let shuttingDown = false;

  try {
    // 3. Configuration.
    const loaded = loadConfig({ env, cwd });
    logger.info(
      {
        configPath: loaded.configPath,
        chains: loaded.config.chains.map((chain) => chain.chainId),
        contracts: loaded.config.contracts.length,
      },
      'configuration loaded',
    );

    // 4. Database.
    const databaseUrl = env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      throw new Error('DATABASE_URL is required');
    }
    pool = createDbClient({ connectionString: databaseUrl, applicationName: 'chain-event-indexer' });
    await waitForDatabase(pool, {
      timeoutMs: options.databaseConnectTimeoutMs ?? DEFAULT_DB_CONNECT_TIMEOUT_MS,
      intervalMs: 1000,
      logger,
    });
    logger.info('database is reachable');

    // 5. Migrations.
    if (options.runMigrations !== false) {
      const result = await runMigrations(pool, defaultMigrationsDir(), {
        logger: (message) => logger.info(message),
      });
      logger.info(
        { applied: result.applied, alreadyApplied: result.skipped.length },
        'migrations are up to date',
      );
    }

    const metrics = createMetrics();
    const status = createPollerStatusStore();

    // 6. Contracts + chain clients.
    const contracts = await registerContracts(pool, loaded.config.contracts);
    logger.info({ contracts: contracts.size }, 'contracts registered');

    const clients = createChainClients(loaded.config.chains);

    const pollerEnabled = options.startPoller ?? parseBooleanEnv(env['POLLER_ENABLED'], true);

    // 7. HTTP server (and the poller, when enabled).
    const built = await buildApp({
      config: loaded.config,
      pool,
      logger,
      metrics,
      status,
      contracts,
      clients,
      apiKey: env['API_KEY'],
      isProduction: env['NODE_ENV'] === 'production',
      startPoller: pollerEnabled,
      ownsPool: true,
    });

    const port = parseIntegerEnv(env['PORT'], 3000);
    const host = env['HOST'] === undefined || env['HOST'] === '' ? '0.0.0.0' : env['HOST'];
    const address = await built.app.listen({ port, host });
    logger.info({ address, port, host, pollerEnabled }, 'chain-event-indexer is listening');

    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

    const shutdown = async (reason = 'manual'): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ reason }, 'shutting down');

      const forcedExit = setTimeout(() => {
        logger.error({ timeoutMs: shutdownTimeoutMs }, 'graceful shutdown timed out, exiting');
        process.exit(1);
      }, shutdownTimeoutMs);
      if (typeof forcedExit.unref === 'function') forcedExit.unref();

      try {
        // Poller first (stops new queries), then the HTTP server, then the pool.
        await built.close();
        logger.info('shutdown complete');
      } catch (error) {
        logger.error({ error: describeError(error) }, 'error while shutting down');
      } finally {
        clearTimeout(forcedExit);
      }
    };

    // 8. Signal handling.
    if (options.installSignalHandlers !== false) {
      const handler = (signal: NodeJS.Signals): void => {
        void shutdown(signal).then(() => {
          process.exit(0);
        });
      };
      process.once('SIGINT', handler);
      process.once('SIGTERM', handler);
    }

    return {
      built,
      config: loaded,
      logger,
      address,
      port,
      host,
      pollerEnabled,
      shutdown,
    };
  } catch (error) {
    if (pool) {
      await closePool(pool);
    }
    throw error;
  }
}
