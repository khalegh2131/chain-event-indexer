import { decodeEventLog, type AbiEvent, type Hex } from 'viem';
import { describeError } from '../utils/errors';
import { toJsonRecord } from '../utils/json';
import type { RawLog } from '../types';

/**
 * Event decoding.
 *
 * Decoded arguments are immediately converted to JSON-safe values (every
 * `bigint` becomes a decimal string) so nothing downstream can accidentally
 * leak a non-serializable value into the database or the API.
 */

export class DecodeError extends Error {
  readonly logIdentifier: string;

  constructor(message: string, logIdentifier: string) {
    super(message);
    this.name = 'DecodeError';
    this.logIdentifier = logIdentifier;
  }
}

export interface DecodedEvent {
  eventName: string;
  args: Record<string, unknown>;
}

export function decodeLog(log: RawLog, abiItem: AbiEvent): DecodedEvent {
  const identifier = `${log.transactionHash ?? 'unknown'}#${log.logIndex?.toString() ?? '?'}`;
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({
      abi: [abiItem],
      data: log.data as Hex,
      topics: log.topics as unknown as [Hex, ...Hex[]],
    }) as unknown as { eventName: string; args: unknown };
  } catch (error) {
    throw new DecodeError(`Failed to decode log ${identifier}: ${describeError(error)}`, identifier);
  }

  const eventName = typeof decoded.eventName === 'string' ? decoded.eventName : String(abiItem.name);
  return {
    eventName,
    args: toJsonRecord(decoded.args ?? {}),
  };
}
