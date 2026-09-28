import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logging.
 *
 * `x-api-key`, `authorization`, RPC URLs and database URLs are redacted in the
 * logger itself so a careless `logger.info({ config })` cannot leak a secret.
 */

export type { Logger };

export const REDACT_PATHS: string[] = [
  'req.headers["x-api-key"]',
  'request.headers["x-api-key"]',
  'headers["x-api-key"]',
  'req.headers.authorization',
  'request.headers.authorization',
  'headers.authorization',
  'req.headers.cookie',
  'apiKey',
  '*.apiKey',
  'rpcUrl',
  '*.rpcUrl',
  '*.rpc_url',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'databaseUrl',
  '*.databaseUrl',
  'password',
  '*.password',
];

export interface CreateLoggerOptions {
  level?: string;
  name?: string;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? process.env['LOG_LEVEL'] ?? 'info';
  const loggerOptions: LoggerOptions = {
    level,
    name: options.name ?? 'chain-event-indexer',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };
  return pino(loggerOptions);
}

/** Silent logger for tests and for `--quiet`-style runs. */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'silent' });
}
