import { describe, expect, it } from 'vitest';
import { DecodeError, decodeLog } from '../../src/chain/decoder';
import { parseEventAbiItem } from '../../src/chain/topic';
import type { RawLog } from '../../src/types';
import {
  ERC20_TRANSFER_SIGNATURE,
  ERC20_TRANSFER_TOPIC0,
  RECIPIENT_ADDRESS,
  SENDER_ADDRESS,
  transferLog,
} from './fixtures';

const transferAbi = parseEventAbiItem(ERC20_TRANSFER_SIGNATURE);

describe('decodeLog', () => {
  it('decodes a Transfer log and converts bigints to strings', () => {
    const log = transferLog({ value: 123456789012345678901234567890n }) as RawLog;
    const decoded = decodeLog(log, transferAbi);

    expect(decoded.eventName).toBe('Transfer');
    expect(decoded.args).toEqual({
      from: SENDER_ADDRESS,
      to: RECIPIENT_ADDRESS,
      value: '123456789012345678901234567890',
    });
    expect(typeof (decoded.args as { value: unknown }).value).toBe('string');
  });

  it('handles zero values', () => {
    const decoded = decodeLog(transferLog({ value: 0n }) as RawLog, transferAbi);
    expect((decoded.args as { value: string }).value).toBe('0');
  });

  it('handles uint256 max values exactly', () => {
    const max = 2n ** 256n - 1n;
    const decoded = decodeLog(transferLog({ value: max }) as RawLog, transferAbi);
    expect((decoded.args as { value: string }).value).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    );
  });

  it('produces JSON-safe args', () => {
    const decoded = decodeLog(transferLog({}) as RawLog, transferAbi);
    expect(() => JSON.stringify(decoded.args)).not.toThrow();
    expect(JSON.stringify(decoded.args)).toContain('"value":"123456789012345678901234567890"');
  });

  it('works with logs produced by a mocked viem-compatible RPC payload', () => {
    // Exactly the shape `eth_getLogs` returns: bigint block numbers, lowercase hex.
    const rpcLog: RawLog = {
      address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      topics: [
        ERC20_TRANSFER_TOPIC0,
        `0x${SENDER_ADDRESS.slice(2).padStart(64, '0')}`,
        `0x${RECIPIENT_ADDRESS.slice(2).padStart(64, '0')}`,
      ],
      data: `0x${(1000n).toString(16).padStart(64, '0')}`,
      blockNumber: 21_000_000n,
      blockHash: `0x${'ab'.repeat(32)}`,
      transactionHash: `0x${'cd'.repeat(32)}`,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    };

    expect(decodeLog(rpcLog, transferAbi).args).toEqual({
      from: SENDER_ADDRESS,
      to: RECIPIENT_ADDRESS,
      value: '1000',
    });
  });

  it('throws DecodeError for a log that does not match the ABI', () => {
    const mismatched: RawLog = {
      ...(transferLog({}) as RawLog),
      topics: [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`],
      data: '0x',
    };

    expect(() => decodeLog(mismatched, transferAbi)).toThrowError(DecodeError);
  });
});
