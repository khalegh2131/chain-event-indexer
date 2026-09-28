import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { createChainClients } from './chain/client';
import { createPoller, type Poller } from './chain/poller';
import { PollerStatusStore, createPollerStatusStore } from './chain/status';
import { closePool, createDbClient, type PoolLike } from './db/client';
import { registerContracts } from './db/repositories/contracts';
import { createMetrics, type Metrics } from './metrics/metrics';
import { createAuthHook } from './server/auth';
import { createErrorHandler, createNotFoundHandler } from './server/errors';
import { registerOpenApi } from './server/openapi';
import { registerEventsRoutes } from './server/routes/events';
import { registerHealthRoutes } from './server/routes/health';
import { registerMetricsRoutes } from './server/routes/metrics';
import { registerStatusRoutes } from './server/routes/status';
import { describeError } from './utils/errors';
import type { ChainClientLike, NormalizedConfig, RegisteredContractMap } from './types';

/**
 * Application builder with explicit dependency injection.
 *
 * Anything passed in is treated as borrowed: `close()` only tears down what this
 * function created (`ownsPool`). Tests therefore build the API with a fake pool,
 * a silent logger and the poller switched off, while `index.ts` owns everything.
 */

export interface BuildAppOptions {
  config: NormalizedConfig;
  logger: Logger;
  /** Borrowed pool. Created from `DATABASE_URL` when omitted. */
  pool?: PoolLike;
  metrics?: Metrics;
  status?: PollerStatusStore;
  clients?: Map<string, ChainClientLike>;
  contracts?: RegisteredContractMap;
  /** Register the configured contracts on boot. Defaults to true. */
  registerContracts?: boolean;
  apiKey?: string | null;
  isProduction?: boolean;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  bodyLimit?: number;
  healthCheckTimeoutMs?: number;
  /**
   * Start the poller as soon as the app is built. Defaults to false so that
   * tests never spawn background intervals by accident; `bootstrap()` passes the
   * value derived from `POLLER_ENABLED`.
   */
  startPoller?: boolean;
  /** Alias of `startPoller` (kept for spec compatibility). */
  pollerEnabled?: boolean;
  /** Register the OpenAPI/Swagger UI routes. Defaults to true. */
  registerDocs?: boolean;
  /**
   * Whether `close()` should tear down the pool. Defaults to true when the pool
   * was created here, false when one was injected.
   */
  ownsPool?: boolean;
  pollerShutdownTimeoutMs?: number;
}

export interface BuiltApp {
  app: FastifyInstance;
  config: NormalizedConfig;
  logger: Logger;
  metrics: Metrics;
  status: PollerStatusStore;
  pool: PoolLike;
  contracts: RegisteredContractMap;
  clients: Map<string, ChainClientLike>;
  poller: Poller | null;
  pollerEnabled: boolean;
  ownsPool: boolean;
  close(): Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_BODY_LIMIT = 1_048_576;
const DEFAULT_HEALTH_TIMEOUT_MS = 2000;
const DEFAULT_POLLER_SHUTDOWN_TIMEOUT_MS = 10_000;

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const logger = options.logger;
  const isProduction = options.isProduction ?? process.env['NODE_ENV'] === 'production';
  const metrics = options.metrics ?? createMetrics();
  const status = options.status ?? createPollerStatusStore();
  const ownsPool = options.ownsPool ?? options.pool === undefined;

  const pool =
    options.pool ??
    createDbClient({
      connectionString: requireDatabaseUrl(),
      applicationName: 'chain-event-indexer',
    });

  try {
    const contracts =
      options.contracts ??
      (options.registerContracts === false
        ? new Map()
        : await registerContracts(pool, options.config.contracts));

    const clients = options.clients ?? createChainClients(options.config.chains);

    // The instance is annotated with the default `FastifyInstance` shape so that
    // route modules do not have to be generic over the logger implementation.
    //
    // `requestIdLogLabel` / `disableRequestLogging` are deliberately not set: both
    // are deprecated in Fastify 5 and removed in 6, and their defaults are already
    // what this service wants (`reqId` log label, request logging on).
    const app = Fastify({
      loggerInstance: logger,
      requestIdHeader: 'x-request-id',
      requestTimeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      connectionTimeout: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
      ajv: {
        // Fastify strips properties that are not in the schema by default. The
        // events route intentionally rejects unknown query parameters with a 400
        // (Zod `.strict()`), so removal must be disabled for Zod to see them.
        customOptions: { removeAdditional: false },
      },
    }) as unknown as FastifyInstance;

    const apiKey = options.apiKey === undefined ? process.env['API_KEY'] : options.apiKey;

    app.setErrorHandler(createErrorHandler({ logger, isProduction }));
    app.setNotFoundHandler(createNotFoundHandler());
    app.addHook('onRequest', createAuthHook({ apiKey }));

    if (options.registerDocs !== false) {
      await registerOpenApi(app);
    }

    registerHealthRoutes(app, {
      db: pool,
      timeoutMs: options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    });
    registerStatusRoutes(app, {
      db: pool,
      config: options.config,
      contracts,
      status,
      pollerEnabled: resolveStartPoller(options),
      isPollerRunning: () => poller?.isRunning() ?? false,
    });
    registerMetricsRoutes(app, { metrics });
    registerEventsRoutes(app, { db: pool });

    await app.ready();

    for (const chain of options.config.chains) {
      status.registerChain(chain.chainId);
    }

    const poller =
      clients.size > 0
        ? createPoller({
            pool,
            config: options.config,
            contracts,
            clients,
            logger,
            metrics,
            status,
            shutdownTimeoutMs:
              options.pollerShutdownTimeoutMs ?? DEFAULT_POLLER_SHUTDOWN_TIMEOUT_MS,
          })
        : null;

    const startPollerResolved = resolveStartPoller(options);
    status.setPollerEnabled(startPollerResolved && poller !== null);
    if (poller && startPollerResolved) {
      poller.start();
    }

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (poller) {
        await poller.stop();
      }
      await app.close();
      if (ownsPool) {
        await closePool(pool);
      }
    };

    return {
      app,
      config: options.config,
      logger,
      metrics,
      status,
      pool,
      contracts,
      clients,
      poller,
      pollerEnabled: startPollerResolved,
      ownsPool,
      close,
    };
  } catch (error) {
    logger.error({ error: describeError(error) }, 'failed to build the application');
    if (ownsPool) {
      await closePool(pool);
    }
    throw error;
  }
}

function resolveStartPoller(options: BuildAppOptions): boolean {
  return options.startPoller ?? options.pollerEnabled ?? false;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error(
      'DATABASE_URL is required when no pool is injected into buildApp(options)',
    );
  }
  return databaseUrl;
}
