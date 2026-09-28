import { buildConfig, type LoadedConfig } from '../../src/config/load';
import type { RawConfig } from '../../src/config/schema';

/** Shared fixtures for unit tests. No network, no database. */

export const ERC20_TRANSFER_SIGNATURE =
  'event Transfer(address indexed from, address indexed to, uint256 value)';

/** keccak256('Transfer(address,address,uint256)') */
export const ERC20_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const USDT_ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7';
export const USDT_ADDRESS_CHECKSUMMED = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const SENDER_ADDRESS = '0x1111111111111111111111111111111111111111';
export const RECIPIENT_ADDRESS = '0x2222222222222222222222222222222222222222';

/**
 * Loosely typed overrides: the raw JSON shape accepts partial chains/contracts
 * because zod applies the documented defaults during validation.
 */
export interface RawConfigOverrides {
  chains?: Array<Record<string, unknown>>;
  contracts?: Array<Record<string, unknown>>;
}

export function rawConfig(overrides: RawConfigOverrides = {}): RawConfig {
  const base = {
    chains: [
      {
        chainId: 1,
        rpcUrl: 'https://ethereum-rpc.publicnode.com',
        confirmations: 12,
        pollIntervalMs: 10_000,
        maxBlockRange: 2000,
      },
    ],
    contracts: [
      {
        chainId: '1',
        address: USDT_ADDRESS,
        eventName: 'Transfer',
        eventSignature: ERC20_TRANSFER_SIGNATURE,
      },
    ],
  };
  return { ...base, ...overrides } as RawConfig;
}

export const VALID_CONFIG: RawConfig = rawConfig();

export function loadFixtureConfig(): LoadedConfig {
  return buildConfig(rawConfig());
}

/** Fully normalised fixture used by ingestion and repository tests. */
export function fixtureConfig(): LoadedConfig {
  return buildConfig(
    rawConfig({
      chains: [
        {
          chainId: '1',
          rpcUrl: 'https://ethereum-rpc.publicnode.com',
          confirmations: 2,
          pollIntervalMs: 1000,
          maxBlockRange: 10,
        },
      ],
      contracts: [
        {
          chainId: '1',
          address: USDT_ADDRESS,
          eventName: 'Transfer',
          eventSignature: ERC20_TRANSFER_SIGNATURE,
          startBlock: '100',
        },
      ],
    }),
  );
}

/** A structurally valid EVM log for `Transfer`. */
export function transferLog(overrides: {
  blockNumber?: bigint;
  logIndex?: number;
  transactionHash?: string;
  blockHash?: string;
  transactionIndex?: number;
  from?: string;
  to?: string;
  value?: bigint;
  address?: string;
}): {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
} {
  const value = overrides.value ?? 123456789012345678901234567890n;
  return {
    address: overrides.address ?? USDT_ADDRESS,
    topics: [
      ERC20_TRANSFER_TOPIC0,
      padAddress(overrides.from ?? SENDER_ADDRESS),
      padAddress(overrides.to ?? RECIPIENT_ADDRESS),
    ],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    blockNumber: overrides.blockNumber ?? 18_000_000n,
    blockHash: overrides.blockHash ?? `0x${'ab'.repeat(32)}`,
    transactionHash: overrides.transactionHash ?? `0x${'cd'.repeat(32)}`,
    transactionIndex: overrides.transactionIndex ?? 3,
    logIndex: overrides.logIndex ?? 7,
  };
}

export function padAddress(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}
