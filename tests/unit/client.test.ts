import { describe, expect, it } from 'vitest';
import {
  ChainEventIndexerClient,
  ChainEventIndexerError,
  buildQueryString,
  createClient,
} from '../../src/client';

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

interface StubResult {
  status: number;
  body: string;
  ok?: boolean;
}

function stubFetch(handler: (url: string, init?: RequestInit) => StubResult): {
  impl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const result = handler(url, init);
    return {
      ok: result.ok ?? (result.status >= 200 && result.status < 300),
      status: result.status,
      text: async () => result.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

describe('buildQueryString', () => {
  it('returns an empty string for no parameters', () => {
    expect(buildQueryString({})).toBe('');
  });

  it('omits undefined and empty values and lowercases the address', () => {
    const query = buildQueryString({
      chainId: '1',
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      eventName: undefined,
      limit: 5,
    });
    expect(query).toBe('?chainId=1&address=0xdac17f958d2ee523a2206206994597c13d831ec7&limit=5');
  });
});

describe('ChainEventIndexerClient', () => {
  it('requires a baseUrl', () => {
    expect(() => new ChainEventIndexerClient({ baseUrl: '   ' })).toThrowError(/baseUrl is required/);
  });

  it('trims trailing slashes from the baseUrl', () => {
    const client = new ChainEventIndexerClient({ baseUrl: 'http://localhost:3000///' });
    expect(client.baseUrl).toBe('http://localhost:3000');
  });

  it('calls the versioned events endpoint with query parameters and the api key', async () => {
    const { impl, calls } = stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ items: [], nextCursor: null }),
    }));

    const client = new ChainEventIndexerClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      fetchImpl: impl,
    });

    const response = await client.getEvents({ chainId: '1', limit: 2 });

    expect(response).toEqual({ items: [], nextCursor: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:3000/api/v1/events?chainId=1&limit=2');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['accept']).toBe('application/json');
  });

  it('omits the api key header when no key is configured', async () => {
    const { impl, calls } = stubFetch(() => ({ status: 200, body: '{"items":[],"nextCursor":null}' }));
    const client = new ChainEventIndexerClient({ baseUrl: 'http://localhost:3000', fetchImpl: impl });

    await client.getEvents();

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBeUndefined();
    expect(calls[0]?.url).toBe('http://localhost:3000/api/v1/events');
  });

  it('calls the unversioned alias when asked', async () => {
    const { impl, calls } = stubFetch(() => ({ status: 200, body: '{"items":[],"nextCursor":null}' }));
    const client = new ChainEventIndexerClient({ baseUrl: 'http://localhost:3000', fetchImpl: impl });

    await client.getEventsAlias({ eventName: 'Transfer' });

    expect(calls[0]?.url).toBe('http://localhost:3000/events?eventName=Transfer');
  });

  it('fetches health and status', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.endsWith('/health')
        ? { status: 200, body: '{"status":"ok","db":"up"}' }
        : { status: 200, body: '{"uptimeSeconds":1,"startedAt":"2024-01-01T00:00:00.000Z","pollerEnabled":true,"pollerRunning":true,"chains":[],"contracts":[]}' },
    );

    const client = new ChainEventIndexerClient({ baseUrl: 'http://localhost:3000', fetchImpl: impl });

    await expect(client.getHealth()).resolves.toEqual({ status: 'ok', db: 'up' });
    const status = await client.getStatus();
    expect(status.pollerRunning).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/health',
      'http://localhost:3000/status',
    ]);
  });

  it('throws a typed error carrying status, code and body for non-2xx responses', async () => {
    const { impl } = stubFetch(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }),
    }));

    const client = new ChainEventIndexerClient({ baseUrl: 'http://localhost:3000', fetchImpl: impl });

    await expect(client.getEvents()).rejects.toThrowError(ChainEventIndexerError);
    try {
      await client.getEvents();
      throw new Error('expected getEvents to throw');
    } catch (error) {
      const typed = error as ChainEventIndexerError;
      expect(typed.status).toBe(401);
      expect(typed.code).toBe('UNAUTHORIZED');
      expect(typed.isClientError).toBe(true);
      expect(typed.isTransportError).toBe(false);
      expect(typed.body).toEqual({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
    }
  });

  it('reports a 400 validation error verbatim', async () => {
    const { impl } = stubFetch(() => ({
      status: 400,
      body: JSON.stringify({ error: { message: 'fromBlock must be less than or equal to toBlock', code: 'VALIDATION_ERROR' } }),
    }));

    const client = new ChainEventIndexerClient({ baseUrl: 'http://localhost:3000', fetchImpl: impl });

    try {
      await client.getEvents({ fromBlock: '10', toBlock: '5' });
      throw new Error('expected getEvents to throw');
    } catch (error) {
      const typed = error as ChainEventIndexerError;
      expect(typed.status).toBe(400);
      expect(typed.code).toBe('VALIDATION_ERROR');
      expect(typed.message).toMatch(/fromBlock must be less than or equal to toBlock/);
    }
  });

  it('maps transport failures to status 0 NETWORK_ERROR', async () => {
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
    }) as unknown as typeof fetch;

    const client = new ChainEventIndexerClient({
      baseUrl: 'http://localhost:3000',
      fetchImpl: failing,
      timeoutMs: 500,
    });

    try {
      await client.getHealth();
      throw new Error('expected getHealth to throw');
    } catch (error) {
      const typed = error as ChainEventIndexerError;
      expect(typed.status).toBe(0);
      expect(typed.code).toBe('NETWORK_ERROR');
      expect(typed.isTransportError).toBe(true);
    }
  });

  it('maps an aborted request to a TIMEOUT error', async () => {
    const aborting = (async () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;

    const client = new ChainEventIndexerClient({
      baseUrl: 'http://localhost:3000',
      fetchImpl: aborting,
      timeoutMs: 1234,
    });

    try {
      await client.getHealth();
      throw new Error('expected getHealth to throw');
    } catch (error) {
      const typed = error as ChainEventIndexerError;
      expect(typed.code).toBe('TIMEOUT');
      expect(typed.message).toMatch(/1234ms/);
    }
  });

  it('returns a rebound client from withBaseUrl', async () => {
    const { impl, calls } = stubFetch(() => ({ status: 200, body: '{"items":[],"nextCursor":null}' }));
    const client = createClient({ baseUrl: 'http://localhost:3000', apiKey: 'k', fetchImpl: impl });

    const other = client.withBaseUrl('http://indexer.internal:8080');
    await other.getEvents();

    expect(calls[0]?.url).toBe('http://indexer.internal:8080/api/v1/events');
  });
});
