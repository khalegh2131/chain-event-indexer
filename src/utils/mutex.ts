/**
 * Minimal, dependency-free mutexes.
 *
 * A single polling loop per chain is still not enough to prevent overlap when a
 * cycle runs longer than the poll interval, so every cycle acquires a lock and
 * a busy cycle is skipped instead of queued.
 */

export class MutexLockedError extends Error {
  constructor(message = 'Mutex is already locked') {
    super(message);
    this.name = 'MutexLockedError';
  }
}

export interface TryRunResult<T> {
  ran: boolean;
  value?: T;
}

export class Mutex {
  private locked = false;

  isLocked(): boolean {
    return this.locked;
  }

  /** Runs `fn` only when the lock is free, otherwise returns `{ ran: false }`. */
  async tryRunExclusive<T>(fn: () => Promise<T>): Promise<TryRunResult<T>> {
    if (this.locked) {
      return { ran: false };
    }
    this.locked = true;
    try {
      const value = await fn();
      return { ran: true, value };
    } finally {
      this.locked = false;
    }
  }

  /** Runs `fn` or throws {@link MutexLockedError} when already locked. */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.locked) {
      throw new MutexLockedError();
    }
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
    }
  }
}

/** A mutex per key, used to serialize overlapping poll cycles per chain. */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>();

  private lockFor(key: string): Mutex {
    const existing = this.locks.get(key);
    if (existing) return existing;
    const created = new Mutex();
    this.locks.set(key, created);
    return created;
  }

  isLocked(key: string): boolean {
    return this.locks.get(key)?.isLocked() ?? false;
  }

  tryRunExclusive<T>(key: string, fn: () => Promise<T>): Promise<TryRunResult<T>> {
    return this.lockFor(key).tryRunExclusive(fn);
  }

  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.lockFor(key).runExclusive(fn);
  }

  clear(): void {
    this.locks.clear();
  }
}
