import { isAddress, type AbiEvent } from 'viem';
import { EventSignatureError, parseEventAbiItem, topic0OfAbiItem } from '../chain/topic';
import { describeError } from '../utils/errors';
import type { NormalizedChain, NormalizedConfig, NormalizedContract } from '../types';
import type { RawConfig } from './schema';

/**
 * Semantic validation and normalization of a parsed configuration file.
 *
 * Fails fast with a complete, readable list of problems so an operator can fix
 * every issue in one pass instead of discovering them one restart at a time.
 */

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}: ${issues.join('; ')}` : message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function normalizeChainId(value: string | number): string {
  const asString = String(value).trim();
  if (!/^\d+$/.test(asString)) {
    throw new ConfigError(`Invalid chainId "${String(value)}": must be a non-negative integer`);
  }
  return BigInt(asString).toString();
}

export function normalizeDecimal(value: string | number, field: string): string {
  const asString = String(value).trim();
  if (!/^\d+$/.test(asString)) {
    throw new ConfigError(`Invalid ${field} "${String(value)}": must be a non-negative integer`);
  }
  return BigInt(asString).toString();
}

export function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  if (!isAddress(trimmed)) {
    throw new ConfigError(`Invalid EVM address "${value}"`);
  }
  return trimmed.toLowerCase();
}

export function normalizeStartBlock(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  return normalizeDecimal(value, 'startBlock');
}

/** Stable identity of a configured contract. */
export function contractKey(chainId: string, address: string, topic0: string): string {
  return `${chainId}:${address.toLowerCase()}:${topic0.toLowerCase()}`;
}

export function compareChainIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

export function normalizeConfig(raw: RawConfig): NormalizedConfig {
  const issues: string[] = [];
  const chains: NormalizedChain[] = [];
  const knownChainIds = new Set<string>();

  for (const [index, chain] of raw.chains.entries()) {
    try {
      const chainId = normalizeChainId(chain.chainId);
      if (knownChainIds.has(chainId)) {
        throw new ConfigError(`duplicate chainId ${chainId}`);
      }
      if (chain.rpcUrl.trim() === '') {
        throw new ConfigError('rpcUrl must not be empty');
      }
      knownChainIds.add(chainId);
      chains.push({
        chainId,
        rpcUrl: chain.rpcUrl.trim(),
        confirmations: chain.confirmations,
        pollIntervalMs: chain.pollIntervalMs,
        maxBlockRange: chain.maxBlockRange,
      });
    } catch (error) {
      issues.push(`chains[${index}]: ${describeError(error)}`);
    }
  }

  const contracts: NormalizedContract[] = [];
  const seenContracts = new Set<string>();

  for (const [index, contract] of raw.contracts.entries()) {
    try {
      const chainId = normalizeChainId(contract.chainId);
      if (!knownChainIds.has(chainId)) {
        throw new ConfigError(`chainId ${chainId} is not declared in "chains"`);
      }
      const address = normalizeAddress(contract.address);
      const eventSignature = contract.eventSignature.trim().replace(/\s+/g, ' ');
      let abiItem: AbiEvent;
      try {
        abiItem = parseEventAbiItem(eventSignature);
      } catch (error) {
        if (error instanceof EventSignatureError) {
          throw new ConfigError(`invalid eventSignature: ${error.message}`);
        }
        throw error;
      }
      const topic0 = topic0OfAbiItem(abiItem);
      if (abiItem.name !== contract.eventName) {
        throw new ConfigError(
          `eventName "${contract.eventName}" does not match the name in eventSignature ("${String(abiItem.name)}")`,
        );
      }
      const key = contractKey(chainId, address, topic0);
      if (seenContracts.has(key)) {
        throw new ConfigError(
          `duplicate contract chainId=${chainId} address=${address} eventSignature=${eventSignature}`,
        );
      }
      seenContracts.add(key);
      contracts.push({
        chainId,
        address,
        eventName: contract.eventName,
        eventSignature,
        topic0,
        startBlock: normalizeStartBlock(contract.startBlock),
        abiItem,
      });
    } catch (error) {
      issues.push(`contracts[${index}]: ${describeError(error)}`);
    }
  }

  if (issues.length > 0) {
    throw new ConfigError('Invalid configuration', issues);
  }

  const sortedChains = [...chains].sort((a, b) => compareChainIds(a.chainId, b.chainId));
  return { chains: sortedChains, contracts };
}

export function chainById(config: NormalizedConfig, chainId: string): NormalizedChain | undefined {
  return config.chains.find((chain) => chain.chainId === chainId);
}

export function contractsForChain(
  config: NormalizedConfig,
  chainId: string,
): NormalizedContract[] {
  return config.contracts.filter((contract) => contract.chainId === chainId);
}
