import { describe, expect, it } from 'vitest';
import { KeyedMutex, Mutex, MutexLockedError } from '../../src/utils/mutex';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('Mutex', () => {
  it('prevents overlapping executions', async () => {
    const mutex = new Mutex();
    const gate = deferred();
    let started = 0;

    const first = mutex.tryRunExclusive(async () => {
      started += 1;
      await gate.promise;
      return 'first';
    });

    const second = await mutex.tryRunExclusive(async () => {
      started += 1;
      return 'second';
    });

    gate.resolve();
    const firstOutcome = await first;

    expect(firstOutcome.ran).toBe(true);
    expect(firstOutcome.value).toBe('first');
    expect(second.ran).toBe(false);
    expect(started).toBe(1);
    expect(mutex.isLocked()).toBe(false);
  });

  it('throws MutexLockedError from runExclusive when busy', async () => {
    const mutex = new Mutex();
    const gate = deferred();

    const first = mutex.runExclusive(async () => {
      await gate.promise;
      return 1;
    });

    await expect(mutex.runExclusive(async () => 2)).rejects.toThrowError(MutexLockedError);

    gate.resolve();
    await expect(first).resolves.toBe(1);
    expect(mutex.isLocked()).toBe(false);
  });

  it('releases the lock when the critical section throws', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);

    expect(mutex.isLocked()).toBe(false);
    await expect(mutex.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('allows re-entry once the lock is released', async () => {
    const mutex = new Mutex();
    expect(await mutex.tryRunExclusive(async () => 'a')).toEqual({ ran: true, value: 'a' });
    expect(await mutex.tryRunExclusive(async () => 'b')).toEqual({ ran: true, value: 'b' });
  });
});

describe('KeyedMutex', () => {
  it('isolates keys from each other', async () => {
    const keyed = new KeyedMutex();
    const gate = deferred();

    const chainOne = keyed.tryRunExclusive('1', async () => {
      await gate.promise;
      return 'chain-1';
    });

    const otherChain = await keyed.tryRunExclusive('137', async () => 'chain-137');

    gate.resolve();

    expect((await chainOne).value).toBe('chain-1');
    expect(otherChain.ran).toBe(true);
    expect(otherChain.value).toBe('chain-137');
    expect(keyed.isLocked('1')).toBe(false);
    expect(keyed.isLocked('137')).toBe(false);
  });

  it('blocks a second run on the same key', async () => {
    const keyed = new KeyedMutex();
    const gate = deferred();

    const first = keyed.tryRunExclusive('1', async () => {
      await gate.promise;
      return 'first';
    });

    expect(keyed.isLocked('1')).toBe(true);
    const second = await keyed.tryRunExclusive('1', async () => 'second');
    expect(second.ran).toBe(false);

    gate.resolve();
    await first;
    expect(keyed.isLocked('1')).toBe(false);
  });
});
