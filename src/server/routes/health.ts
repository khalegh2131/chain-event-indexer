import type { FastifyInstance } from 'fastify';
import { checkDatabase, type Queryable } from '../../db/client';

/**
 * `GET /health`
 *
 * Always public (never behind the API key) so container orchestrators and load
 * balancers can probe it. 200 when PostgreSQL answers, 503 otherwise.
 */

export interface HealthRouteOptions {
  db: Queryable;
  timeoutMs?: number;
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get(
    '/health',
    {
      schema: {
        tags: ['observability'],
        summary: 'Liveness and database readiness probe',
        description:
          'Returns 200 with `{ status: "ok", db: "up" }` when PostgreSQL is reachable, 503 otherwise.',
      },
    },
    async (_request, reply) => {
      const healthy = await checkDatabase(options.db, options.timeoutMs ?? 2000);
      if (!healthy) {
        reply.status(503).send({
          status: 'error',
          db: 'down',
          error: {
            message: 'Database is not reachable',
            code: 'DB_UNAVAILABLE',
          },
        });
        return;
      }
      reply.status(200).send({ status: 'ok', db: 'up' });
    },
  );
}
