import { describe, expect, it } from 'vitest';
import { fetchLogs, isRangeTooLargeError } from '../../src/chain/fetchLogs';
import type { ChainClientLike, GetLogsArgs, RawLog } from '../../src/types';
import { transferLog } from './fixtures';

const noSleep = async (): Promise<void> => undefined;

class FakeChainClient implements ChainClientLike {
  readonly ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];

  constructor(
    private readonly handler: (args: GetLogsArgs, callIndex: number) => Promise<RawLog[]> | RawLog[],
  ) {}

  async getBlockNumber(): Promise<bigint> {
    return 0n;
  }

  async getLogs(args: GetLogsArgs): Promise<RawLog[]> {
    const callIndex = this.ranges.length;
    this.ranges.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
    return this.handler(args, callIndex);
  }
}

const baseParams = {
  chainId: '1',
  address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  topic0: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
};

describe('fetchLogs chunking', () => {
  it('splits the requested range into maxBlockRange sized windows', async () => {
    const client = new FakeChainClient(() => []);

    const result = await fetchLogs(
      { ...baseParams, fromBlock: 1n, toBlock: 25n, maxBlockRange: 10 },
      client,
    );

    expect(client.ranges).toEqual([
      { fromBlock: 1n, toBlock: 10n },
      { fromBlock: 11n, toBlock: 20n },
      { fromBlock: 21n, toBlock: 25n },
    ]);
    expect(result.rangesRequested).toBe(3);
    expect(result.rangeReduced).toBe(false);
    expect(result.logs).toEqual([]);
  });

  it('issues a single request when the range already fits', async () => {
    const client = new FakeChainClient(() => []);
    await fetchLogs({ ...baseParams, fromBlock: 5n, toBlock: 9n, maxBlockRange: 1000 }, client);
    expect(client.ranges).toEqual([{ fromBlock: 5n, toBlock: 9n }]);
  });

  it('handles a single-block range', async () => {
    const client = new FakeChainClient(() => [transferLog({ blockNumber: 7n }) as RawLog]);
    const result = await fetchLogs(
      { ...baseParams, fromBlock: 7n, toBlock: 7n, maxBlockRange: 10 },
      client,
    );
    expect(result.logs).toHaveLength(1);
    expect(client.ranges).toEqual([{ fromBlock: 7n, toBlock: 7n }]);
  });

  it('makes no request when fromBlock is beyond toBlock', async () => {
    const client = new FakeChainClient(() => []);
    const result = await fetchLogs(
      { ...baseParams, fromBlock: 10n, toBlock: 9n, maxBlockRange: 10 },
      client,
    );
    expect(client.ranges).toEqual([]);
    expect(result.logs).toEqual([]);
  });

  it('accumulates logs from every window', async () => {
    const client = new FakeChainClient((args) =>
      args.fromBlock === 11n ? [transferLog({ blockNumber: 12n }) as RawLog] : [],
    );

    const result = await fetchLogs(
      { ...baseParams, fromBlock: 1n, toBlock: 20n, maxBlockRange: 10 },
      client,
    );

    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]?.blockNumber).toBe(12n);
  });
});

describe('fetchLogs adaptive range reduction', () => {
  it('halves the window when the provider rejects it, then succeeds', async () => {
    const client = new FakeChainClient((_args, callIndex) => {
      if (callIndex === 0) {
        throw new Error('query returned more than 10000 results');
      }
      return [];
    });

    const result = await fetchLogs(
      { ...baseParams, fromBlock: 0n, toBlock: 7n, maxBlockRange: 8 },
      client,
      { retryOptions: { attempts: 1 }, sleep: noSleep },
    );

    expect(result.rangeReduced).toBe(true);
    expect(result.effectiveMaxRange).toBe(4);
    expect(client.ranges).toEqual([
      { fromBlock: 0n, toBlock: 7n },
      { fromBlock: 0n, toBlock: 3n },
      { fromBlock: 4n, toBlock: 7n },
    ]);
  });

  it('keeps shrinking down to a single block before giving up', async () => {
    const client = new FakeChainClient(() => {
      throw Object.assign(new Error('limit exceeded'), { code: -32005 });
    });

    await expect(
      fetchLogs(
        { ...baseParams, fromBlock: 0n, toBlock: 7n, maxBlockRange: 8 },
        client,
        { retryOptions: { attempts: 1 }, sleep: noSleep },
      ),
    ).rejects.toThrow(/limit exceeded/);

    expect(client.ranges.map((range) => range.toBlock)).toEqual([7n, 3n, 1n, 0n]);
    expect(client.ranges).toHaveLength(4);
  });

  it('does not swallow unrelated errors', async () => {
    const client = new FakeChainClient(() => {
      throw Object.assign(new Error('invalid params'), { code: -32602 });
    });

    await expect(
      fetchLogs(
        { ...baseParams, fromBlock: 0n, toBlock: 7n, maxBlockRange: 8 },
        client,
        { retryOptions: { attempts: 1 }, sleep: noSleep },
      ),
    ).rejects.toThrow(/invalid params/);

    expect(client.ranges).toHaveLength(1);
  });
});

describe('isRangeTooLargeError', () => {
  it('recognises provider specific messages', () => {
    expect(isRangeTooLargeError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeTooLargeError(new Error('block range is too wide'))).toBe(true);
    expect(isRangeTooLargeError(new Error('response size exceeded'))).toBe(true);
    expect(isRangeTooLargeError(new Error('Log response size exceeded'))).toBe(true);
  });

  it('recognises provider specific codes', () => {
    expect(isRangeTooLargeError(Object.assign(new Error('nope'), { code: -32005 }))).toBe(true);
    expect(isRangeTooLargeError(Object.assign(new Error('nope'), { code: '-32007' }))).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isRangeTooLargeError(Object.assign(new Error('invalid params'), { code: -32602 }))).toBe(
      false,
    );
    expect(isRangeTooLargeError(new Error('fetch failed'))).toBe(false);
  });
});
