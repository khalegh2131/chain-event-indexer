import { createPublicClient, http } from 'viem';
import { maskUrl } from '../utils/env';
import type { ChainClientLike, NormalizedChain } from '../types';

/**
 * viem public (read-only) HTTP clients.
 *
 * One client per chain, created once at startup. The transport-level retry is
 * disabled on purpose: retries are owned by `utils/retry` so backoff, jitter and
 * retry/no-retry decisions stay observable and testable.
 */

export interface CreateChainClientOptions {
  /** Per-request HTTP timeout in milliseconds. */
  timeoutMs?: number;
  /** Provider-side JSON-RPC batching (off by default for predictable latency). */
  batch?: boolean;
}

export function createChainClient(
  chain: NormalizedChain,
  options: CreateChainClientOptions = {},
): ChainClientLike {
  const client = createPublicClient({
    transport: http(chain.rpcUrl, {
      timeout: options.timeoutMs ?? 15_000,
      retryCount: 0,
      batch: options.batch ?? false,
    }),
  });
  return client as unknown as ChainClientLike;
}

export function createChainClients(
  chains: readonly NormalizedChain[],
  options: CreateChainClientOptions = {},
): Map<string, ChainClientLike> {
  const clients = new Map<string, ChainClientLike>();
  for (const chain of chains) {
    clients.set(chain.chainId, createChainClient(chain, options));
  }
  return clients;
}

/** Safe representation of an RPC URL for logs and `/status` output. */
export function describeRpcUrl(rpcUrl: string): string {
  return maskUrl(rpcUrl);
}
