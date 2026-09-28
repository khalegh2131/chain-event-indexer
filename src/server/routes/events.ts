import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAddress } from 'viem';
import { z } from 'zod';
import type { Queryable } from '../../db/client';
import { mapEventRow, queryEvents } from '../../db/repositories/events';
import { InvalidCursorError, decodeCursor, encodeCursor } from '../../utils/cursor';
import type { EventItem, EventsResponse } from '../../types';
import { badRequest } from '../errors';

/**
 * `GET /events` and `GET /api/v1/events`
 *
 * Both paths are served by the exact same handler: the unversioned path is a
 * convenience alias, the versioned path is the stable contract that internal
 * consumers (projects 003 and 9) should depend on.
 */

export interface EventsRouteOptions {
  db: Queryable;
  defaultLimit?: number;
  maxLimit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Query validation.
 *
 * `.strict()` is intentional: an unknown or misspelled query parameter is a 400
 * instead of a silently unfiltered response.
 */
export const eventsQuerySchema = z
  .object({
    chainId: z.string().regex(/^\d+$/, 'chainId must be a non-negative integer').optional(),
    address: z.string().min(1).optional(),
    eventName: z.string().min(1).max(200).optional(),
    fromBlock: z.string().regex(/^\d+$/, 'fromBlock must be a non-negative integer').optional(),
    toBlock: z.string().regex(/^\d+$/, 'toBlock must be a non-negative integer').optional(),
    txHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'txHash must be 0x followed by 64 hex characters')
      .optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z
      .string()
      .regex(/^\d+$/, `limit must be an integer between 1 and ${MAX_LIMIT}`)
      .optional(),
  })
  .strict();

export type EventsQueryInput = z.infer<typeof eventsQuerySchema>;

/** JSON Schema twin of {@link eventsQuerySchema} used for OpenAPI generation. */
export const eventsQueryJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chainId: {
      type: 'string',
      pattern: '^\\d+$',
      description: 'EVM chain id as a decimal string.',
    },
    address: {
      type: 'string',
      description:
        'Contract address (case-insensitive), e.g. 0xdac17f958d2ee523a2206206994597c13d831ec7.',
    },
    eventName: {
      type: 'string',
      maxLength: 200,
      description: 'Registered event name, for example `Transfer`.',
    },
    fromBlock: {
      type: 'string',
      pattern: '^\\d+$',
      description: 'Inclusive lower bound on block number.',
    },
    toBlock: {
      type: 'string',
      pattern: '^\\d+$',
      description: 'Inclusive upper bound on block number.',
    },
    txHash: {
      type: 'string',
      pattern: '^0x[0-9a-fA-F]{64}$',
      description: 'Filter by transaction hash.',
    },
    cursor: {
      type: 'string',
      maxLength: 512,
      description: 'Opaque cursor returned as `nextCursor` by a previous request.',
    },
    limit: {
      type: 'string',
      pattern: '^\\d+$',
      description: `Page size, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
    },
  },
};

async function handleEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  options: EventsRouteOptions,
): Promise<void> {
  const parsed = eventsQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    throw badRequest(
      'Invalid query parameters',
      'VALIDATION_ERROR',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  const query = parsed.data;
  const maxLimit = options.maxLimit ?? MAX_LIMIT;
  const limit = query.limit === undefined ? (options.defaultLimit ?? DEFAULT_LIMIT) : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw badRequest(`limit must be an integer between 1 and ${maxLimit}`, 'VALIDATION_ERROR');
  }

  if (query.address !== undefined && !isAddress(query.address)) {
    throw badRequest('address must be a valid EVM address', 'VALIDATION_ERROR');
  }

  if (
    query.fromBlock !== undefined &&
    query.toBlock !== undefined &&
    BigInt(query.fromBlock) > BigInt(query.toBlock)
  ) {
    throw badRequest('fromBlock must be less than or equal to toBlock', 'VALIDATION_ERROR');
  }

  let cursorId: string | undefined;
  if (query.cursor !== undefined) {
    try {
      cursorId = decodeCursor(query.cursor);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw badRequest('cursor is not a valid pagination cursor', 'INVALID_CURSOR');
      }
      throw error;
    }
  }

  const rows = await queryEvents(options.db, {
    chainId: query.chainId,
    address: query.address === undefined ? undefined : query.address.toLowerCase(),
    eventName: query.eventName,
    fromBlock: query.fromBlock,
    toBlock: query.toBlock,
    txHash: query.txHash,
    cursorId,
    limit,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const items: EventItem[] = pageRows.map(mapEventRow);

  const body: EventsResponse = {
    items,
    nextCursor: hasMore && lastRow ? encodeCursor(lastRow.id) : null,
  };

  reply.status(200).send(body);
}

function routeOptions(versioned: boolean): Record<string, unknown> {
  return {
    // Validation is performed by Zod inside the handler so every rejection uses
    // the documented `{ error: { message, code } }` envelope. The JSON Schema is
    // still attached for OpenAPI generation.
    attachValidation: true,
    schema: {
      tags: ['events'],
      summary: versioned ? 'List indexed events (v1)' : 'List indexed events',
      description: versioned
        ? 'Stable versioned endpoint for consumers (projects 003 and 9). Identical to `GET /events`.'
        : 'Convenience alias of `GET /api/v1/events`. Both paths share one handler.',
      querystring: eventsQueryJsonSchema,
    },
  };
}

export function registerEventsRoutes(app: FastifyInstance, options: EventsRouteOptions): void {
  app.get('/events', routeOptions(false), (request, reply) =>
    handleEvents(request, reply, options),
  );
  app.get('/api/v1/events', routeOptions(true), (request, reply) =>
    handleEvents(request, reply, options),
  );
}
