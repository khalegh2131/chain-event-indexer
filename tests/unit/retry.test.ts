import { describe, expect, it } from 'vitest';
import {
  collectErrorFacts,
  computeBackoffDelay,
  defaultShouldRetry,
  isInvalidRequestError,
  isTransientError,
  retry,
} from '../../src/utils/retry';

const noSleep = async (): Promise<void> => undefined;

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function rpcError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

describe('error classification', () => {
  it('treats 429 and 5xx responses as transient', () => {
    expect(isTransientError(httpError('Too Many Requests', 429))).toBe(true);
    expect(isTransientError(httpError('Internal Server Error', 500))).toBe(true);
    expect(isTransientError(httpError('Service Unavailable', 503))).toBe(true);
  });

  it('treats network level failures as transient', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new Error('connect ECONNRESET 1.2.3.4:443'))).toBe(true);
    expect(isTransientError(new Error('request timed out'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  it('treats provider range-limit JSON-RPC codes as transient', () => {
    expect(isTransientError(rpcError('limit exceeded', -32005))).toBe(true);
  });

  it('classifies invalid parameters as non-retryable', () => {
    expect(isInvalidRequestError(rpcError('invalid params', -32602))).toBe(true);
    expect(isInvalidRequestError(httpError('bad request: invalid argument', 400))).toBe(true);
    expect(defaultShouldRetry(httpError('bad request: invalid argument', 400))).toBe(false);
  });

  it('walks the cause chain', () => {
    const inner = httpError('429 Too Many Requests', 429);
    const outer = new Error('RPC request failed') as Error & { cause?: unknown };
    outer.cause = inner;

    expect(isTransientError(outer)).toBe(true);
    expect(collectErrorFacts(outer).statuses).toContain(429);
  });

  it('retries unknown failures by default', () => {
    expect(defaultShouldRetry(new Error('something unexpected'))).toBe(true);
  });
});

describe('retry', () => {
  it('returns the first successful result without retrying', async () => {
    let calls = 0;
    const value = await retry(
      async () => {
        calls += 1;
        return 'ok';
      },
      {},
      { sleep: noSleep },
    );

    expect(value).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries transient failures and then succeeds', async () => {
    let lastAttempt = 0;
    const result = await retry(
      async (attempt) => {
        lastAttempt = attempt;
        if (attempt < 3) {
          throw httpError('Service Unavailable', 503);
        }
        return 'recovered';
      },
      { attempts: 5 },
      { sleep: noSleep, random: () => 0 },
    );

    expect(result).toBe('recovered');
    expect(lastAttempt).toBe(3);
  });

  it('gives up after the configured number of attempts', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw httpError('Too Many Requests', 429);
        },
        { attempts: 3 },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/Too Many Requests/);
    expect(calls).toBe(3);
  });

  it('never retries an invalid request', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw rpcError('invalid params', -32602);
        },
        { attempts: 5 },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/invalid params/);
    expect(calls).toBe(1);
  });

  it('reports the delay it will wait before each attempt', async () => {
    const observed: number[] = [];
    await expect(
      retry(
        async () => {
          throw new Error('fetch failed');
        },
        {
          attempts: 3,
          baseDelayMs: 100,
          jitter: 'none',
          onRetry: (info) => observed.push(info.delayMs),
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow();
    expect(observed).toEqual([100, 200]);
  });

  it('honours a custom shouldRetry', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new Error('fetch failed');
        },
        { attempts: 5, shouldRetry: () => false },
        { sleep: noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('propagates a non-Error throw untouched', async () => {
    await expect(
      retry(
        async () => {
          throw 'string failure';
        },
        { attempts: 1 },
        { sleep: noSleep },
      ),
    ).rejects.toBe('string failure');
  });
});

describe('backoff computation', () => {
  it('doubles without jitter up to the ceiling', () => {
    const options = { baseDelayMs: 100, maxDelayMs: 500, jitter: 'none' as const };
    expect(computeBackoffDelay(1, options)).toBe(100);
    expect(computeBackoffDelay(2, options)).toBe(200);
    expect(computeBackoffDelay(3, options)).toBe(400);
    expect(computeBackoffDelay(4, options)).toBe(500);
    expect(computeBackoffDelay(9, options)).toBe(500);
  });

  it('applies full jitter within [0, exponential]', () => {
    expect(computeBackoffDelay(3, { baseDelayMs: 100, jitter: 'full' }, () => 0)).toBe(0);
    expect(computeBackoffDelay(3, { baseDelayMs: 100, jitter: 'full' }, () => 0.5)).toBe(200);
    expect(computeBackoffDelay(3, { baseDelayMs: 100, jitter: 'full' }, () => 1)).toBe(400);
  });

  it('uses documented defaults', () => {
    expect(computeBackoffDelay(1, {}, () => 1)).toBe(250);
    expect(computeBackoffDelay(1, { jitter: 'none' })).toBe(250);
  });
});
