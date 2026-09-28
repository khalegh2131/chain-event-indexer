import { nowIso, toSeconds } from '../utils/time';
import type { ChainStatusSummary } from '../types';

/**
 * In-memory runtime status.
 *
 * The database is the source of truth for persisted progress; this store keeps
 * the ephemeral facts that only the poller knows (last observed head, last
 * error, in-flight cycle) so `/status` can answer without extra queries.
 */

export interface ChainRuntimeEntry {
  chainId: string;
  latestBlock: string | null;
  targetBlock: string | null;
  lastPollAt: string | null;
  lastPollOkAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
}

export interface ContractRuntimeEntry {
  contractId: string;
  lastIndexedBlock: string | null;
  updatedAt: string | null;
}

export class PollerStatusStore {
  readonly startedAtMs: number;
  pollerEnabled = false;
  private running = false;
  private readonly chains = new Map<string, ChainRuntimeEntry>();
  private readonly contracts = new Map<string, ContractRuntimeEntry>();

  constructor(private readonly clock: () => number = Date.now) {
    this.startedAtMs = clock();
  }

  private chainEntry(chainId: string): ChainRuntimeEntry {
    const existing = this.chains.get(chainId);
    if (existing) return existing;
    const created: ChainRuntimeEntry = {
      chainId,
      latestBlock: null,
      targetBlock: null,
      lastPollAt: null,
      lastPollOkAt: null,
      lastError: null,
      lastDurationMs: null,
    };
    this.chains.set(chainId, created);
    return created;
  }

  private contractEntry(contractId: string): ContractRuntimeEntry {
    const existing = this.contracts.get(contractId);
    if (existing) return existing;
    const created: ContractRuntimeEntry = {
      contractId,
      lastIndexedBlock: null,
      updatedAt: null,
    };
    this.contracts.set(contractId, created);
    return created;
  }

  registerChain(chainId: string): void {
    this.chainEntry(chainId);
  }

  setPollerEnabled(enabled: boolean): void {
    this.pollerEnabled = enabled;
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Records the head/target observed for a chain and clears the last error. */
  setChainPoll(chainId: string, latestBlock: string, targetBlock: string): void {
    const entry = this.chainEntry(chainId);
    entry.latestBlock = latestBlock;
    entry.targetBlock = targetBlock;
    entry.lastPollAt = nowIso();
    entry.lastError = null;
  }

  /** A chain whose head has not reached the confirmations threshold yet. */
  setChainSkipped(chainId: string, latestBlock: string): void {
    const entry = this.chainEntry(chainId);
    entry.latestBlock = latestBlock;
    entry.targetBlock = null;
    entry.lastPollAt = nowIso();
    entry.lastError = null;
  }

  setChainError(chainId: string, message: string): void {
    const entry = this.chainEntry(chainId);
    entry.lastPollAt = nowIso();
    entry.lastError = message;
  }

  recordChainSuccess(chainId: string, durationMs: number): void {
    const entry = this.chainEntry(chainId);
    entry.lastPollOkAt = nowIso();
    entry.lastDurationMs = durationMs;
  }

  recordChainFailure(chainId: string, durationMs: number): void {
    const entry = this.chainEntry(chainId);
    entry.lastDurationMs = durationMs;
  }

  setContractIndexed(contractId: string, blockNumber: string): void {
    const entry = this.contractEntry(contractId);
    entry.lastIndexedBlock = blockNumber;
    entry.updatedAt = nowIso();
  }

  getChain(chainId: string): ChainRuntimeEntry | undefined {
    return this.chains.get(chainId);
  }

  getContract(contractId: string): ContractRuntimeEntry | undefined {
    return this.contracts.get(contractId);
  }

  listChains(): ChainRuntimeEntry[] {
    return [...this.chains.values()];
  }

  uptimeSeconds(): number {
    return toSeconds(Math.max(0, this.clock() - this.startedAtMs));
  }

  startedAtIso(): string {
    return new Date(this.startedAtMs).toISOString();
  }

  chainSummaries(): ChainStatusSummary[] {
    return this.listChains().map((entry) => ({
      chainId: entry.chainId,
      latestBlock: entry.latestBlock,
      targetBlock: entry.targetBlock,
      lastPollAt: entry.lastPollAt,
      lastPollOkAt: entry.lastPollOkAt,
      lastError: entry.lastError,
    }));
  }
}

export function createPollerStatusStore(clock?: () => number): PollerStatusStore {
  return new PollerStatusStore(clock);
}
