import { KestrelApiError, KestrelTimeoutError } from './errors.js';
import type {
  AnalyticsSummaryResponse,
  AnalyticsWindow,
  BulkIngestResponse,
  CancelDeliveryResponse,
  CsvUploadInput,
  DeliveryDetailResponse,
  KestrelClientOptions,
  ListDeliveriesParams,
  PaginatedDeliveriesResponse,
  ReplayDeliveryResponse,
  SendBulkOptions,
  SendEventInput,
  SendEventResponse,
} from './types.js';

export const DEFAULT_SDK_TIMEOUT_MS = 10_000;

interface InternalRequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly jsonBody?: Record<string, unknown>;
  readonly rawBody?: RequestInit['body'];
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

function normalizeApiV1BaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error('KestrelClient baseUrl must be a non-empty URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid KestrelClient baseUrl: "${rawBaseUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('KestrelClient baseUrl must use http:// or https:// protocol');
  }

  const stripped = trimmed.replace(/\/+$/, '');
  return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getReader' in value &&
    typeof (value as ReadableStream<Uint8Array>).getReader === 'function'
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

function toSafeBlobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function toCsvBlob(input: CsvUploadInput): Promise<Blob> {
  if (input instanceof Blob) {
    return input;
  }

  if (typeof input === 'string') {
    return new Blob([input], { type: 'text/csv' });
  }

  if (input instanceof Uint8Array) {
    return new Blob([toSafeBlobPart(input)], { type: 'text/csv' });
  }

  if (isReadableStream(input)) {
    const reader = input.getReader();
    const parts: ArrayBuffer[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value !== undefined) {
          parts.push(toSafeBlobPart(value));
        }
      }
    } finally {
      reader.releaseLock();
    }
    return new Blob(parts, { type: 'text/csv' });
  }

  if (isAsyncIterable(input)) {
    const encoder = new TextEncoder();
    const parts: ArrayBuffer[] = [];
    for await (const chunk of input) {
      if (typeof chunk === 'string') {
        parts.push(toSafeBlobPart(encoder.encode(chunk)));
      } else {
        parts.push(toSafeBlobPart(chunk));
      }
    }
    return new Blob(parts, { type: 'text/csv' });
  }

  throw new Error('Unsupported CSV upload input; expected Blob, Buffer, Uint8Array, string, or stream');
}

export class KestrelClient {
  readonly #v1BaseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #workspaceId: string | undefined;
  readonly #fetchImpl: typeof globalThis.fetch;

  readonly events: {
    readonly send: (input: SendEventInput) => Promise<SendEventResponse>;
    readonly sendBulk: (csv: CsvUploadInput, options?: SendBulkOptions) => Promise<BulkIngestResponse>;
  };

  readonly deliveries: {
    readonly list: (params?: ListDeliveriesParams) => Promise<PaginatedDeliveriesResponse>;
    readonly get: (id: string) => Promise<DeliveryDetailResponse>;
    readonly replay: (id: string) => Promise<ReplayDeliveryResponse>;
    readonly cancel: (id: string) => Promise<CancelDeliveryResponse>;
  };

  readonly analytics: {
    readonly summary: (window?: AnalyticsWindow) => Promise<AnalyticsSummaryResponse>;
  };

  constructor(options: KestrelClientOptions) {
    this.#v1BaseUrl = normalizeApiV1BaseUrl(options.baseUrl);

    const trimmedKey = options.apiKey.trim();
    if (trimmedKey.length === 0) {
      throw new Error('KestrelClient apiKey must be a non-empty string');
    }
    this.#apiKey = trimmedKey;

    const timeoutMs = options.timeoutMs ?? DEFAULT_SDK_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('KestrelClient timeoutMs must be a positive number');
    }
    this.#timeoutMs = timeoutMs;
    this.#workspaceId = options.workspaceId?.trim() || undefined;
    this.#fetchImpl = options.fetch ?? globalThis.fetch;

    this.events = {
      send: (input: SendEventInput) => this.#sendEvent(input),
      sendBulk: (csv: CsvUploadInput, bulkOptions?: SendBulkOptions) =>
        this.#sendBulkEvents(csv, bulkOptions),
    };

    this.deliveries = {
      list: (params?: ListDeliveriesParams) => this.#listDeliveries(params),
      get: (id: string) => this.#getDelivery(id),
      replay: (id: string) => this.#replayDelivery(id),
      cancel: (id: string) => this.#cancelDelivery(id),
    };

    this.analytics = {
      summary: (window?: AnalyticsWindow) => this.#getAnalyticsSummary(window),
    };
  }

  async #sendEvent(input: SendEventInput): Promise<SendEventResponse> {
    const deliverAtIso =
      input.deliverAt instanceof Date ? input.deliverAt.toISOString() : input.deliverAt;

    const trimmedIdempotencyKey = input.idempotencyKey?.trim();
    const headers: Record<string, string> = {};
    if (trimmedIdempotencyKey && trimmedIdempotencyKey.length > 0) {
      headers['Idempotency-Key'] = trimmedIdempotencyKey;
    }

    const body: Record<string, unknown> = {
      event: input.event,
      payload: input.payload,
      ...(input.recipient !== undefined ? { recipient: input.recipient } : {}),
      ...(deliverAtIso !== undefined ? { deliverAt: deliverAtIso } : {}),
      ...(trimmedIdempotencyKey && trimmedIdempotencyKey.length > 0
        ? { idempotencyKey: trimmedIdempotencyKey }
        : {}),
    };

    return this.#request<SendEventResponse>({
      method: 'POST',
      path: '/events',
      jsonBody: body,
      headers,
    });
  }

  async #sendBulkEvents(
    csv: CsvUploadInput,
    options: SendBulkOptions = {},
  ): Promise<BulkIngestResponse> {
    const blob = await toCsvBlob(csv);
    const formData = new FormData();
    formData.append('file', blob, options.filename ?? 'events.csv');

    return this.#request<BulkIngestResponse>({
      method: 'POST',
      path: '/events/bulk',
      rawBody: formData,
      timeoutMs: options.timeoutMs,
    });
  }

  async #listDeliveries(params: ListDeliveriesParams = {}): Promise<PaginatedDeliveriesResponse> {
    return this.#request<PaginatedDeliveriesResponse>({
      method: 'GET',
      path: '/deliveries',
      query: {
        limit: params.limit,
        cursor: params.cursor,
        status: params.status,
        eventName: params.eventName,
        integrationId: params.integrationId,
      },
    });
  }

  async #getDelivery(id: string): Promise<DeliveryDetailResponse> {
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      throw new Error('Delivery id must be a non-empty string');
    }

    return this.#request<DeliveryDetailResponse>({
      method: 'GET',
      path: `/deliveries/${encodeURIComponent(trimmed)}`,
    });
  }

  async #replayDelivery(id: string): Promise<ReplayDeliveryResponse> {
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      throw new Error('Delivery id must be a non-empty string');
    }

    return this.#request<ReplayDeliveryResponse>({
      method: 'POST',
      path: `/deliveries/${encodeURIComponent(trimmed)}/replay`,
    });
  }

  async #cancelDelivery(id: string): Promise<CancelDeliveryResponse> {
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      throw new Error('Delivery id must be a non-empty string');
    }

    return this.#request<CancelDeliveryResponse>({
      method: 'POST',
      path: `/deliveries/${encodeURIComponent(trimmed)}/cancel`,
    });
  }

  async #getAnalyticsSummary(window?: AnalyticsWindow): Promise<AnalyticsSummaryResponse> {
    return this.#request<AnalyticsSummaryResponse>({
      method: 'GET',
      path: '/analytics/summary',
      query: {
        window,
      },
    });
  }

  async #request<TResponse>(options: InternalRequestOptions): Promise<TResponse> {
    const url = new URL(`${this.#v1BaseUrl}${options.path}`);
    if (options.query !== undefined) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, application/problem+json',
      Authorization: `Bearer ${this.#apiKey}`,
      ...(this.#apiKey.startsWith('kmq_live_') ? { 'X-API-Key': this.#apiKey } : {}),
      ...(this.#workspaceId !== undefined ? { 'X-Workspace-Id': this.#workspaceId } : {}),
      ...(options.headers ?? {}),
    };

    let body: RequestInit['body'] = options.rawBody;
    if (options.jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.jsonBody);
    }

    const effectiveTimeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, effectiveTimeoutMs);

    let response: Response;
    try {
      response = await this.#fetchImpl(url.toString(), {
        method: options.method,
        headers,
        body,
        signal: abortController.signal,
      });
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        throw new KestrelTimeoutError(url.toString(), effectiveTimeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      throw await KestrelApiError.fromResponse(response, `${ url.pathname }${ url.search }`);
    }

    if (response.status === 204) {
      return undefined as TResponse;
    }

    return (await response.json()) as TResponse;
  }
}
