import { describe, expect, it } from 'vitest';
import { EventSignatureError, deriveTopic0, parseEventAbiItem, topic0OfAbiItem } from '../../src/chain/topic';
import { ERC20_TRANSFER_SIGNATURE, ERC20_TRANSFER_TOPIC0 } from './fixtures';

/** keccak256('Approval(address,address,uint256)') — the canonical ERC-20 Approval topic. */
const ERC20_APPROVAL_TOPIC0 =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

describe('topic0 derivation', () => {
  it('derives the canonical ERC-20 Transfer topic0', () => {
    expect(deriveTopic0(ERC20_TRANSFER_SIGNATURE)).toBe(ERC20_TRANSFER_TOPIC0);
  });

  it('derives the canonical ERC-20 Approval topic0', () => {
    expect(
      deriveTopic0('event Approval(address indexed owner, address indexed spender, uint256 value)'),
    ).toBe(ERC20_APPROVAL_TOPIC0);
  });

  it('ignores the `indexed` qualifier: ERC-20 and ERC-721 Transfer share one topic0', () => {
    // Documented production caveat: topic0 hashes the canonical signature only, so
    // `Transfer(address,address,uint256)` is identical for ERC-20 and ERC-721
    // (the tokenId is the third argument in both). Decoding relies on the configured
    // ABI, and the indexer keys contracts by chainId + address + topic0.
    const erc20 = deriveTopic0(ERC20_TRANSFER_SIGNATURE);
    const erc721 = deriveTopic0(
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    );
    expect(erc721).toBe(erc20);
    expect(erc721).toBe(ERC20_TRANSFER_TOPIC0);
  });

  it('produces different topics when the parameter types differ', () => {
    const transfer = deriveTopic0(ERC20_TRANSFER_SIGNATURE);
    const deposit = deriveTopic0('event Deposit(address indexed dst, uint256 wad)');
    expect(deposit).not.toBe(transfer);
    expect(deposit).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is stable across calls', () => {
    expect(deriveTopic0(ERC20_TRANSFER_SIGNATURE)).toBe(deriveTopic0(ERC20_TRANSFER_SIGNATURE));
  });

  it('ignores surrounding whitespace', () => {
    expect(deriveTopic0(`  ${ERC20_TRANSFER_SIGNATURE}  `)).toBe(ERC20_TRANSFER_TOPIC0);
  });
});

describe('parseEventAbiItem', () => {
  it('returns a parsed event with its inputs', () => {
    const abiItem = parseEventAbiItem(ERC20_TRANSFER_SIGNATURE);
    expect(abiItem.type).toBe('event');
    expect(abiItem.name).toBe('Transfer');
    expect(abiItem.inputs).toHaveLength(3);
    expect(abiItem.inputs.map((input) => input.type)).toEqual(['address', 'address', 'uint256']);
    // viem omits `indexed` for non-indexed inputs instead of emitting `false`.
    expect(abiItem.inputs.map((input) => input.indexed === true)).toEqual([true, true, false]);
  });

  it('rejects a function signature', () => {
    expect(() => parseEventAbiItem('function transfer(address to, uint256 value)')).toThrowError(
      EventSignatureError,
    );
  });

  it('rejects a constructor signature', () => {
    expect(() => parseEventAbiItem('constructor(uint256 supply)')).toThrowError(
      EventSignatureError,
    );
  });

  it('rejects free-form text', () => {
    expect(() => parseEventAbiItem('not an abi item at all')).toThrowError(EventSignatureError);
  });

  it('rejects an event with an invalid parameter type', () => {
    expect(() => parseEventAbiItem('event Broken(uint257 value)')).toThrowError(
      EventSignatureError,
    );
  });

  it('exposes the same topic through topic0OfAbiItem', () => {
    const abiItem = parseEventAbiItem(ERC20_TRANSFER_SIGNATURE);
    expect(topic0OfAbiItem(abiItem)).toBe(ERC20_TRANSFER_TOPIC0);
  });
});
