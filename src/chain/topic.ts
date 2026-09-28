import { parseAbiItem, toEventSelector, type AbiEvent } from 'viem';
import { describeError } from '../utils/errors';

/**
 * Topic derivation helpers.
 *
 * `topic0` is the keccak256 hash of the canonical event signature
 * (`EventName(type1,type2,...)`) and is what the RPC `eth_getLogs` filter
 * matches on, so it is derived once at startup rather than per request.
 */

export class EventSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventSignatureError';
  }
}

export function parseEventAbiItem(eventSignature: string): AbiEvent {
  let parsed: unknown;
  try {
    parsed = parseAbiItem(eventSignature.trim());
  } catch (error) {
    throw new EventSignatureError(
      `"${eventSignature}" is not a valid ABI item: ${describeError(error)}`,
    );
  }
  const candidate = parsed as { type?: string };
  if (candidate.type !== 'event') {
    throw new EventSignatureError(`"${eventSignature}" does not describe an event`);
  }
  return parsed as AbiEvent;
}

export function topic0OfAbiItem(abiItem: AbiEvent): string {
  return toEventSelector(abiItem);
}

/** Convenience wrapper: human-readable signature -> topic0 hex string. */
export function deriveTopic0(eventSignature: string): string {
  return topic0OfAbiItem(parseEventAbiItem(eventSignature));
}
