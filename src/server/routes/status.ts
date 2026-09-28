import type { FastifyInstance } from 'fastify';
import type { PollerStatusStore } from '../../chain/status';
import { contractKey } from '../../config/normalize';
import type { Queryable } from '../../db/client';
import { listIngestionStates } from '../../db/repositories/state';
import type {
  ChainStatusSummary,
  ContractStatusSummary,
  NormalizedConfig,
  RegisteredContractMap,
  StatusResponse,
} from '../../types';

/**
 * `GET /status`
 *
 * Operational view of the indexer: process uptime, poller state, per-chain head
 * information and the per-contract ingestion lag. `lastIndexedBlock` comes from
 * the database (source of truth); head/target comes from the in-memory runtime
 * store.
 */

export interface StatusRouteOptions {
  db: Queryable;
  config: NormalizedConfig;
  contracts: RegisteredContractMap;
  status: PollerStatusStore;
  pollerEnabled: boolean;
  isPollerRunning: () => boolean;
}

export function registerStatusRoutes(app: FastifyInstance, options: StatusRouteOptions): void {
  app.get(
    '/status',
    {
      schema: {
        tags: ['observability'],
        summary: 'Indexer status',
        description:
          'Uptime, poller state, per-chain latest/target block and per-contract ingestion lag (lag is null until a target block is known).',
      },
    },
    async (_request, reply) => {
      const states = await listIngestionStates(options.db);
      const stateByContractId = new Map(states.map((state) => [state.contractId, state]));
      const runtimeChains = new Map(
        options.status.listChains().map((entry) => [entry.chainId, entry]),
      );

      const chains: ChainStatusSummary[] = options.config.chains.map((chain) => {
        const runtime = runtimeChains.get(chain.chainId);
        return {
          chainId: chain.chainId,
          latestBlock: runtime?.latestBlock ?? null,
          targetBlock: runtime?.targetBlock ?? null,
          lastPollAt: runtime?.lastPollAt ?? null,
          lastPollOkAt: runtime?.lastPollOkAt ?? null,
          lastError: runtime?.lastError ?? null,
        };
      });

      const contracts: ContractStatusSummary[] = options.config.contracts.map((contract) => {
        const registered = options.contracts.get(
          contractKey(contract.chainId, contract.address, contract.topic0),
        );
        const state = registered ? stateByContractId.get(registered.id) : undefined;
        const lastIndexedBlock = state ? state.lastFinalizedBlock : null;
        const targetBlock = runtimeChains.get(contract.chainId)?.targetBlock ?? null;

        let lag: string | null = null;
        if (lastIndexedBlock !== null && targetBlock !== null) {
          const last = BigInt(lastIndexedBlock);
          const target = BigInt(targetBlock);
          lag = (target > last ? target - last : 0n).toString();
        }

        return {
          chainId: contract.chainId,
          address: contract.address,
          eventName: contract.eventName,
          lastIndexedBlock,
          targetBlock,
          lag,
        };
      });

      const body: StatusResponse = {
        uptimeSeconds: options.status.uptimeSeconds(),
        startedAt: options.status.startedAtIso(),
        pollerEnabled: options.pollerEnabled,
        pollerRunning: options.isPollerRunning(),
        chains,
        contracts,
      };

      reply.status(200).send(body);
    },
  );
}
