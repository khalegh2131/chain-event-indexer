import { sleep as defaultSleep } from './time';

/**
 * Retry with exponential backoff and jitter.
 *
 * RPC providers are routinely flaky: 429s, 5xx, dropped sockets and timeouts
 * are all expected. Invalid-request errors (bad params, unknown method) will
 * never succeed on retry, so they short-circuit immediately.
 */

export interface RetryOptions {
  /** Total attempts, including the first one. Defaults to 5. */
  attempts?: number;
  /** Base delay in milliseconds. Defaults to 250. */
  baseDelayMs?: number;
  /** Upper bound for a single delay. Defaults to 10_000. */
  maxDelayMs?: number;
  /** `full` applies uniform jitter in [0, delay], `none` disables jitter. */
  jitter?: 'full' | 'none';
  /** Decides whether an error is worth another attempt. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before every backoff sleep. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export interface RetryDependencies {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface ErrorFacts {
  names: string[];
  messages: string[];
  codes: string[];
  statuses: number[];
}

const MAX_CAUSE_DEPTH = 6;

/** Walks the `cause` chain of a viem/RPC error and collects comparable facts. */
export function collectErrorFacts(error: unknown): ErrorFacts {
  const facts: ErrorFacts = { names: [], messages: [], codes: [], statuses: [] };
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || current === undefined) break;
    if (current instanceof Error) {
      facts.names.push(current.name);
      facts.messages.push(current.message);
    } else if (typeof current === 'string') {
      facts.messages.push(current);
    } else if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (typeof record['name'] === 'string') facts.names.push(record['name']);
      if (typeof record['message'] === 'string') facts.messages.push(record['message']);
      if (typeof record['shortMessage'] === 'string') facts.messages.push(record['shortMessage']);
      if (typeof record['details'] === 'string') facts.messages.push(record['details']);
      if (typeof record['body'] === 'string') facts.messages.push(record['body']);
      if (Array.isArray(record['metaMessages'])) {
        for (const entry of record['metaMessages']) {
          if (typeof entry === 'string') facts.messages.push(entry);
        }
      }
    }
    current =
      current instanceof Error
        ? current.cause
        : typeof current === 'object' && current !== null
          ? (current as Record<string, unknown>)['cause']
          : undefined;
  }

  // Numeric codes live on the outer-most objects, so scan them separately.
  let cursor: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor !== null && cursor !== undefined; ) {
    if (typeof cursor === 'object') {
      const record = cursor as Record<string, unknown>;
      if (record['code'] !== undefined) facts.codes.push(String(record['code']));
      if (typeof record['status'] === 'number') facts.statuses.push(record['status']);
      if (typeof record['statusCode'] === 'number') facts.statuses.push(record['statusCode']);
      cursor = record['cause'];
      depth += 1;
      continue;
    }
    break;
  }
  return facts;
}

const TRANSIENT_MESSAGE_PATTERNS: RegExp[] = [
  /\b(408|425|429|500|502|503|504)\b/,
  /rate limit/i,
  /too many requests/i,
  /timed? ?out/i,
  /timeout/i,
  /temporar(y|ily)/i,
  /try again/i,
  /service unavailable/i,
  /server error/i,
  /connection (reset|refused|closed|error)/i,
  /network error/i,
  /socket hang up/i,
  /fetch failed/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|UND_ERR/i,
  /query (exceeds|returned more than)/i,
  /block range is too (large|wide)/i,
  /response size exceeded/i,
  /limit exceeded/i,
];

const INVALID_REQUEST_MESSAGE_PATTERNS: RegExp[] = [
  /invalid params/i,
  /invalid argument/i,
  /invalid request/i,
  /method not found/i,
  /unsupported (method|operation)/i,
  /parse error/i,
  /missing (required )?param/i,
  /unauthorized/i,
  /forbidden/i,
  /not found/i,
];

const INVALID_CODES = new Set(['-32600', '-32601', '-32602', '-32700']);
const RANGE_LIMIT_CODES = new Set(['-32005', '-32007', '-32014']);

function matches(patterns: RegExp[], values: string[]): boolean {
  return values.some((value) => patterns.some((pattern) => pattern.test(value)));
}

export function isTransientError(error: unknown): boolean {
  const facts = collectErrorFacts(error);
  if (facts.names.includes('AbortError') || facts.names.includes('TimeoutError')) return true;
  if (facts.statuses.some((status) => status === 429 || (status >= 500 && status <= 599))) {
    return true;
  }
  if (facts.codes.some((code) => RANGE_LIMIT_CODES.has(code))) return true;
  return matches(TRANSIENT_MESSAGE_PATTERNS, [...facts.messages, ...facts.names]);
}

export function isInvalidRequestError(error: unknown): boolean {
  const facts = collectErrorFacts(error);
  if (facts.names.includes('InvalidCursorError')) return false;
  if (facts.codes.some((code) => INVALID_CODES.has(code))) return true;
  if (facts.statuses.some((status) => [400, 401, 403, 404, 405, 415, 422].includes(status))) {
    return true;
  }
  return matches(INVALID_REQUEST_MESSAGE_PATTERNS, facts.messages);
}

export function defaultShouldRetry(error: unknown): boolean {
  if (isTransientError(error)) return true;
  if (isInvalidRequestError(error)) return false;
  // Unknown failures are retried: the cost of one extra attempt is far lower
  // than silently stalling the ingestion cursor.
  return true;
}

export function computeBackoffDelay(
  attempt: number,
  options: RetryOptions = {},
  random: () => number = Math.random,
): number {
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const jitter = options.jitter ?? 'full';
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  if (jitter === 'none') return exponential;
  return Math.max(0, Math.floor(random() * exponential));
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
  dependencies: RetryDependencies = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const sleep = dependencies.sleep ?? defaultSleep;
  const random = dependencies.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = computeBackoffDelay(attempt, options, random);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Retry operation failed');
}
