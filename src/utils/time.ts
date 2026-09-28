/**
 * Time helpers shared by the API, the poller and the tests.
 */

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

/** Promise-based sleep that can be cancelled with an AbortSignal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, ms);
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    function onAbort(): void {
      finish();
      reject(createAbortError());
    }
    if (signal) {
      if (signal.aborted) {
        finish();
        reject(createAbortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Rejects with {@link TimeoutError} when `promise` does not settle in time. */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = `Operation timed out after ${timeoutMs}ms`,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(message));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function elapsedMs(startedAt: number, now: number = Date.now()): number {
  return Math.max(0, now - startedAt);
}

export function toSeconds(ms: number): number {
  return Math.round((ms / 1000) * 1000) / 1000;
}
