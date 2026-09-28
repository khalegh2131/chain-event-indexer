import type { FastifyInstance } from 'fastify';
import type { Metrics } from '../../metrics/metrics';

/**
 * `GET /metrics`
 *
 * Prometheus text exposition format produced by prom-client. Protected by the
 * API key when one is configured.
 */

export interface MetricsRouteOptions {
  metrics: Metrics;
}

export function registerMetricsRoutes(app: FastifyInstance, options: MetricsRouteOptions): void {
  app.get(
    '/metrics',
    {
      schema: {
        tags: ['observability'],
        summary: 'Prometheus metrics',
        description: `Prometheus exposition format. Custom series:
- \`indexer_poll_success_total{chain_id}\`
- \`indexer_poll_error_total{chain_id}\`
- \`indexer_events_inserted_total{chain_id,event_name}\`
- \`indexer_events_conflict_total{chain_id,event_name}\`
- \`indexer_last_indexed_block{chain_id,contract_address}\`
- \`indexer_target_block{chain_id}\`
- \`indexer_poll_duration_seconds{chain_id}\``,
        produces: ['text/plain'],
      },
    },
    async (_request, reply) => {
      const body = await options.metrics.render();
      reply.status(200).header('content-type', options.metrics.contentType).send(body);
    },
  );
}
