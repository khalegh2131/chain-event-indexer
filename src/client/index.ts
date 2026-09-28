import type {
  ApiErrorBody,
  EventItem,
  EventsResponse,
  GetEventsParams,
  HealthResponse,
  StatusResponse,
} from '../types';

/**
 * Typed client SDK for internal consumers (projects 003 and 9).
 *
 * Depends on nothing but Node built-ins and the global `fetch`. Every non-2xx
 * response is turned into a {@link ChainEventIndexerError} carrying the HTTP
 * status, the server error code and the parsed body.
 */

export interface ChainEventIndexerClientOptions {
  /** Base URL of the indexer, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Sent as `x-api-key` when provided. */
  apiKey?: string;
  /** Injectable fetch implementation (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to 15_000. */
  timeoutMs?: number;
  /** Extra headers added to every request. */
  headers?: Record<string, string>;
}

export interface ChainEventIndexerErrorOptions {
  status: number;
  code: string;
  body: unknown;
}

export class ChainEventIndexerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(message: string, options: ChainEventIndexerErrorOptions) {
    super(message);
    this.name = 'ChainEventIndexerError';
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }

  /** True for 4xx responses caused by the caller. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** True when the request never produced an HTTP response. */
  get isTransportError(): boolean {
    return this.status === 0;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ChainEventIndexerClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: ChainEventIndexerClientOptions) {
    const baseUrl = options.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error('ChainEventIndexerClient: baseUrl is required');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey?.trim() === '' ? undefined : options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraHeaders = options.headers ?? {};

    const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!fetchImpl) {
      throw new Error(
        'ChainEventIndexerClient: no fetch implementation available; pass fetchImpl explicitly',
      );
    }
    this.fetchImpl = fetchImpl;
  }

  /** `GET /health` (never requires the API key). */
  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }

  /** `GET /status` */
  async getStatus(): Promise<StatusResponse> {
    return this.request<StatusResponse>('/status');
  }

  /** `GET /api/v1/events` — the stable, versioned events endpoint. */
  async getEvents(params: GetEventsParams = {}): Promise<EventsResponse> {
    return this.request<EventsResponse>(`/api/v1/events${buildQueryString(params)}`);
  }

  /** Convenience: the unversioned alias, for parity checks and smoke tests. */
  async getEventsAlias(params: GetEventsParams = {}): Promise<EventsResponse> {
    return this.request<EventsResponse>(`/events${buildQueryString(params)}`);
  }

  /** Returns a copy of this client pointing at another base URL. */
  withBaseUrl(baseUrl: string): ChainEventIndexerClient {
    return new ChainEventIndexerClient({
      baseUrl,
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: this.extraHeaders,
    });
  }

  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.extraHeaders,
    };
    if (hasBody) {
      headers['content-type'] = 'application/json';
    }
    if (this.apiKey !== undefined) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  private async request<T>(pathname: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: controller.signal,
      });

      const text = await response.text();
      const body = text === '' ? null : parseJsonOrNull(text);

      if (!response.ok) {
        throw new ChainEventIndexerError(
          extractErrorMessage(body) ?? `Request failed with status ${response.status}`,
          {
            status: response.status,
            code: extractErrorCode(body) ?? 'HTTP_ERROR',
            body,
          },
        );
      }

      return body as T;
    } catch (error) {
      if (error instanceof ChainEventIndexerError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ChainEventIndexerError(
          `Request to ${pathname} timed out after ${this.timeoutMs}ms`,
          { status: 0, code: 'TIMEOUT', body: null },
        );
      }
      throw new ChainEventIndexerError(
        error instanceof Error ? error.message : String(error),
        { status: 0, code: 'NETWORK_ERROR', body: null },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function buildQueryString(params: GetEventsParams): string {
  const search = new URLSearchParams();
  const entries: Array<[string, string | number | undefined]> = [
    ['chainId', params.chainId],
    ['address', params.address === undefined ? undefined : params.address.toLowerCase()],
    ['eventName', params.eventName],
    ['fromBlock', params.fromBlock],
    ['toBlock', params.toBlock],
    ['txHash', params.txHash],
    ['cursor', params.cursor],
    ['limit', params.limit],
  ];

  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }

  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

export function createClient(
  options: ChainEventIndexerClientOptions,
): ChainEventIndexerClient {
  return new ChainEventIndexerClient(options);
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractErrorMessage(body: unknown): string | null {
  const error = (body as ApiErrorBody | null)?.error;
  if (error && typeof error.message === 'string' && error.message !== '') {
    return error.message;
  }
  return null;
}

function extractErrorCode(body: unknown): string | null {
  const error = (body as ApiErrorBody | null)?.error;
  if (error && typeof error.code === 'string' && error.code !== '') {
    return error.code;
  }
  return null;
}

export type { EventItem, EventsResponse, GetEventsParams, HealthResponse, StatusResponse };
export default ChainEventIndexerClient;
