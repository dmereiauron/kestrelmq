export interface ProblemDetailsPayload {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly timestamp: string;
  readonly errors?: readonly string[];
}

export interface KestrelApiErrorInit {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly instance: string;
  readonly timestamp: string;
  readonly errors?: readonly string[];
  readonly retryAfterSec?: number | null;
  readonly requestId?: string | null;
}

function parseRetryAfterHeader(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

export class KestrelApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly instance: string;
  readonly timestamp: string;
  readonly errors: readonly string[];
  readonly retryAfterSec: number | null;
  readonly requestId: string | null;

  constructor(init: KestrelApiErrorInit) {
    super(init.detail);
    this.name = 'KestrelApiError';
    this.status = init.status;
    this.type = init.type;
    this.title = init.title;
    this.detail = init.detail;
    this.instance = init.instance;
    this.timestamp = init.timestamp;
    this.errors = init.errors ? [...init.errors] : [];
    this.retryAfterSec = init.retryAfterSec ?? null;
    this.requestId = init.requestId ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static async fromResponse(response: Response, fallbackInstance: string): Promise<KestrelApiError> {
    const status = response.status;
    const retryAfterSec = parseRetryAfterHeader(response.headers.get('retry-after'));
    const requestId = response.headers.get('x-request-id');
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    const rawText = await response.text();
    if (
      rawText.trim().length > 0 &&
      (contentType.includes('application/problem+json') || contentType.includes('application/json'))
    ) {
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          const rawErrors = record['errors'];
          const errors = Array.isArray(rawErrors)
            ? rawErrors.filter((item): item is string => typeof item === 'string')
            : [];

          return new KestrelApiError({
            status: typeof record['status'] === 'number' ? record['status'] : status,
            type: typeof record['type'] === 'string' ? record['type'] : 'about:blank',
            title:
              typeof record['title'] === 'string'
                ? record['title']
                : response.statusText || `HTTP ${status}`,
            detail:
              typeof record['detail'] === 'string' && record['detail'].length > 0
                ? record['detail']
                : response.statusText || `Request failed with HTTP ${status}`,
            instance:
              typeof record['instance'] === 'string' ? record['instance'] : fallbackInstance,
            timestamp:
              typeof record['timestamp'] === 'string'
                ? record['timestamp']
                : new Date().toISOString(),
            errors,
            retryAfterSec,
            requestId,
          });
        }
      } catch {
        // Fall through to plain-text fallback when upstream body is malformed JSON
      }
    }

    const fallbackDetail =
      rawText.trim().length > 0
        ? rawText.trim()
        : response.statusText || `Request failed with HTTP ${status}`;

    return new KestrelApiError({
      status,
      type: 'about:blank',
      title: response.statusText || `HTTP ${status}`,
      detail: fallbackDetail,
      instance: fallbackInstance,
      timestamp: new Date().toISOString(),
      errors: [],
      retryAfterSec,
      requestId,
    });
  }
}

export class KestrelTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly url: string;

  constructor(url: string, timeoutMs: number) {
    super(`KestrelMQ request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'KestrelTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
