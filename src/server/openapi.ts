import fs from 'node:fs';
import path from 'node:path';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

/**
 * OpenAPI 3 documentation.
 *
 * - UI at `/docs`
 * - raw document at `/docs/json`
 *
 * Response schemas are injected through swagger's `transform` hook so they are
 * documentation-only: Fastify never serializes responses through them, which
 * keeps dynamic payloads such as decoded `args` intact.
 */

export const API_TITLE = 'Chain Event Indexer API';

export function resolvePackageVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
    const contents = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(contents) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const ERROR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['message', 'code'],
      properties: {
        message: { type: 'string' },
        code: { type: 'string' },
        details: { description: 'Optional machine-readable details.' },
      },
    },
  },
};

const EVENT_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: [
    'id',
    'chainId',
    'contractAddress',
    'eventName',
    'txHash',
    'logIndex',
    'blockNumber',
    'blockHash',
    'transactionIndex',
    'args',
    'rawTopics',
    'data',
    'indexedAt',
  ],
  properties: {
    id: { type: 'string', description: 'Internal row id, exposed as a string.' },
    chainId: { type: 'string', description: 'EVM chain id, always a string.' },
    contractAddress: { type: 'string', description: 'Lowercase contract address.' },
    eventName: { type: 'string' },
    txHash: { type: 'string' },
    logIndex: { type: 'string', description: 'Log index within the block.' },
    blockNumber: { type: 'string', description: 'Block number, always a string.' },
    blockHash: { type: 'string' },
    transactionIndex: { type: 'string', description: 'Transaction index, always a string.' },
    args: {
      type: 'object',
      additionalProperties: true,
      description: 'Decoded, JSON-safe event arguments (uint256 values are decimal strings).',
    },
    rawTopics: { type: 'array', items: { type: 'string' } },
    data: { type: 'string' },
    indexedAt: { type: 'string', format: 'date-time' },
  },
};

const EVENTS_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', items: { $ref: '#/components/schemas/EventItem' } },
    nextCursor: {
      type: 'string',
      nullable: true,
      description: 'Opaque cursor for the next page, or null when the page is the last one.',
    },
  },
};

const EVENT_ROUTE_RESPONSES: Record<string, unknown> = {
  '200': {
    description: 'A page of indexed events, ordered by block number, log index and id.',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/EventsResponse' } },
    },
  },
  '400': {
    description: 'Invalid query parameters.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
  '401': {
    description: 'Missing or invalid `x-api-key`.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
  '500': {
    description: 'Unexpected server error.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
};

const EVENT_ROUTE_PATHS = new Set(['/events', '/api/v1/events']);

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: API_TITLE,
        version: resolvePackageVersion(),
        description:
          'Config-driven EVM chain event indexer. Events are indexed idempotently by `(chain_id, tx_hash, log_index)` after a configurable confirmations threshold.',
        license: { name: 'MIT' },
      },
      tags: [
        { name: 'events', description: 'Query indexed events (versioned and aliased paths).' },
        { name: 'observability', description: 'Health, status and Prometheus metrics.' },
      ],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' },
        },
        schemas: {
          EventItem: EVENT_ITEM_SCHEMA,
          EventsResponse: EVENTS_RESPONSE_SCHEMA,
          ErrorResponse: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    transform: ({ schema, url }) => {
      const pathname = url.split('?')[0] ?? url;
      if (EVENT_ROUTE_PATHS.has(pathname)) {
        return { url, schema: { ...schema, response: EVENT_ROUTE_RESPONSES } };
      }
      return { url, schema };
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
  });
}
