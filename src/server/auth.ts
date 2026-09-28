import { createHash, timingSafeEqual } from 'node:crypto';
import type { onRequestHookHandler } from 'fastify';

/**
 * Optional API-key authentication.
 *
 * When `API_KEY` is unset the API is open (local development). When it is set,
 * everything except `/health` requires a matching `x-api-key` header. The
 * comparison hashes both operands first so it is timing-safe even when the
 * key lengths differ.
 */

export const PUBLIC_PATHS: readonly string[] = ['/health'];
export const PROTECTED_PREFIXES: readonly string[] = ['/api/v1', '/events', '/metrics', '/docs'];

export function normalizePath(url: string): string {
  const withoutQuery = url.split('?')[0] ?? '';
  if (withoutQuery === '') return '/';
  return withoutQuery.length > 1 && withoutQuery.endsWith('/')
    ? withoutQuery.slice(0, -1)
    : withoutQuery;
}

export function isProtectedPath(url: string): boolean {
  const path = normalizePath(url);
  if (PUBLIC_PATHS.includes(path)) return false;
  return PROTECTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function safeCompare(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export interface AuthOptions {
  apiKey?: string | null | undefined;
}

export function createAuthHook(options: AuthOptions): onRequestHookHandler {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';

  return (request, reply, done) => {
    if (apiKey === '') {
      done();
      return;
    }
    if (!isProtectedPath(request.url)) {
      done();
      return;
    }
    const header = request.headers['x-api-key'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (typeof provided !== 'string' || provided === '' || !safeCompare(provided, apiKey)) {
      void reply.status(401).send({
        error: {
          message: 'Unauthorized',
          code: 'UNAUTHORIZED',
        },
      });
      return;
    }
    done();
  };
}
