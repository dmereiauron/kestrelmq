import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { KestrelApiError, KestrelClient, KestrelTimeoutError } from './index.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

describe('@kestrelmq/sdk — KestrelClient & KestrelApiError', () => {
  it('validates constructor options and normalizes baseUrl with or without /v1 suffix', async () => {
    expect(() => new KestrelClient({ baseUrl: '', apiKey: 'kmq_live_abc' })).toThrow();
    expect(() => new KestrelClient({ baseUrl: 'ftp://invalid', apiKey: 'kmq_live_abc' })).toThrow();
    expect(() => new KestrelClient({ baseUrl: 'http://localhost:3000', apiKey: '  ' })).toThrow();
    expect(
      () => new KestrelClient({ baseUrl: 'http://localhost:3000', apiKey: 'kmq_live_abc', timeoutMs: 0 }),
    ).toThrow();

    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        workspaceId: 'ws-1',
        window: '24h',
        from: '2026-11-26T00:00:00.000Z',
        to: '2026-11-27T00:00:00.000Z',
        totalEvents: 5,
        totalDeliveries: 5,
        deliveriesByStatus: {
          DELIVERED: 5,
          FAILED: 0,
          RETRYING: 0,
          PENDING: 0,
          SCHEDULED: 0,
          PAUSED: 0,
          CANCELED: 0,
        },
        successRate: 100,
        avgDurationMs: 25,
        p95DurationMs: 40,
        cached: false,
      }),
    );

    const clientWithV1 = new KestrelClient({
      baseUrl: 'https://api.kestrelmq.io/v1/',
      apiKey: 'kmq_live_secret_token',
      fetch: fetchSpy,
    });

    await clientWithV1.analytics.summary('7d');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe('https://api.kestrelmq.io/v1/analytics/summary?window=7d');
    const headers = calledInit?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer kmq_live_secret_token');
    expect(headers['X-API-Key']).toBe('kmq_live_secret_token');
  });

  it('sends events with Idempotency-Key header, Date -> ISO deliverAt conversion, and recipient', async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(
        {
          eventId: 'evt_1',
          eventName: 'order.paid',
          workspaceId: 'ws_1',
          idempotencyKey: 'idem-123',
          idempotentReplay: false,
          scheduledFor: '2026-12-01T00:00:00.000Z',
          schemaWarnings: null,
          deliveryIds: ['del_1'],
          deliveries: [
            {
              id: 'del_1',
              routingRuleId: 'rule_1',
              integrationId: 'int_1',
              status: 'SCHEDULED',
              scheduledFor: '2026-12-01T00:00:00.000Z',
            },
          ],
          createdAt: '2026-11-27T18:00:00.000Z',
        },
        202,
      ),
    );

    const client = new KestrelClient({
      baseUrl: 'http://localhost:3000/',
      apiKey: 'kmq_live_key_123',
      fetch: fetchSpy,
    });

    const deliverAtDate = new Date('2026-12-01T00:00:00.000Z');
    const result = await client.events.send({
      event: 'order.paid',
      payload: { orderId: 'ord_99', amount: 150 },
      recipient: { email: 'ada@kestrelmq.io' },
      deliverAt: deliverAtDate,
      idempotencyKey: 'idem-123',
    });

    expect(result.eventId).toBe('evt_1');
    expect(result.deliveryIds).toEqual(['del_1']);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/events');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('idem-123');
    expect(headers['Content-Type']).toBe('application/json');

    const parsedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(parsedBody).toEqual({
      event: 'order.paid',
      payload: { orderId: 'ord_99', amount: 150 },
      recipient: { email: 'ada@kestrelmq.io' },
      deliverAt: '2026-12-01T00:00:00.000Z',
      idempotencyKey: 'idem-123',
    });
  });

  it('uploads CSV via multipart/form-data from Buffer, Blob, and Node Readable stream', async () => {
    const bulkResponse = {
      totalRows: 2,
      importedEvents: 2,
      createdDeliveries: 2,
      skippedDuplicates: 0,
      failedRows: 0,
      errors: [],
    };

    const fetchSpy = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse(bulkResponse, 202));

    const client = new KestrelClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'kmq_live_bulk_key',
      fetch: fetchSpy,
    });

    const csvText = 'event_name,payload\norder.paid,"{""id"":1}"\n';

    await client.events.sendBulk(Buffer.from(csvText, 'utf8'), { filename: 'batch.csv' });
    await client.events.sendBulk(new Blob([csvText], { type: 'text/csv' }));
    await client.events.sendBulk(Readable.from([csvText]));

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchSpy.mock.calls) {
      expect(url).toBe('http://localhost:3000/v1/events/bulk');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      const uploaded = form.get('file');
      expect(uploaded).toBeInstanceOf(Blob);
      expect(await (uploaded as Blob).text()).toBe(csvText);
    }
  });

  it('executes deliveries.list (cursor pagination), get, replay, and cancel with proper query/path encoding', async () => {
    const fetchSpy = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ data: [], nextCursor: 'cur_next', hasMore: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'del_1', status: 'DELIVERED', attempts: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'del_1', status: 'PENDING', replayed: true, jobId: 'job_1' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: 'del_2', status: 'CANCELED', canceled: true, removedFromQueue: true }),
      );

    const client = new KestrelClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'eyJhbGciOiJIUzI1NiJ9.jwt.sig',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      fetch: fetchSpy,
    });

    const page = await client.deliveries.list({
      limit: 25,
      cursor: 'eyJjcmVhdGVkQXQiOiIyMDI2In0',
      status: 'FAILED',
      eventName: 'order.paid',
    });
    expect(page.nextCursor).toBe('cur_next');

    await client.deliveries.get('del_1');
    await client.deliveries.replay('del_1');
    await client.deliveries.cancel('del_2');

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'http://localhost:3000/v1/deliveries?limit=25&cursor=eyJjcmVhdGVkQXQiOiIyMDI2In0&status=FAILED&eventName=order.paid',
    );
    const jwtHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(jwtHeaders['Authorization']).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.jwt.sig');
    expect(jwtHeaders['X-API-Key']).toBeUndefined();
    expect(jwtHeaders['X-Workspace-Id']).toBe('11111111-1111-4111-8111-111111111111');

    expect(fetchSpy.mock.calls[1]?.[0]).toBe('http://localhost:3000/v1/deliveries/del_1');
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe('GET');

    expect(fetchSpy.mock.calls[2]?.[0]).toBe('http://localhost:3000/v1/deliveries/del_1/replay');
    expect(fetchSpy.mock.calls[2]?.[1]?.method).toBe('POST');

    expect(fetchSpy.mock.calls[3]?.[0]).toBe('http://localhost:3000/v1/deliveries/del_2/cancel');
    expect(fetchSpy.mock.calls[3]?.[1]?.method).toBe('POST');
  });

  it('parses RFC 9457 application/problem+json errors into KestrelApiError and handles timeouts', async () => {
    const problemBody = {
      type: 'https://errors.kestrelmq.io/too-many-requests',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Workspace rate limit exceeded',
      instance: '/v1/events',
      timestamp: '2026-11-27T18:00:00.000Z',
      errors: ['Quota exceeded for FREE plan'],
    };

    const fetchSpy = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(problemBody), {
          status: 429,
          headers: {
            'content-type': 'application/problem+json; charset=utf-8',
            'retry-after': '12',
            'x-request-id': 'req-abc-123',
          },
        }),
      )
      .mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      );

    const client = new KestrelClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'kmq_live_rate_test',
      timeoutMs: 30,
      fetch: fetchSpy,
    });

    let caughtError: unknown;
    try {
      await client.events.send({ event: 'order.paid', payload: {} });
    } catch (err: unknown) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(KestrelApiError);
    const apiErr = caughtError as KestrelApiError;
    expect(apiErr.status).toBe(429);
    expect(apiErr.type).toBe('https://errors.kestrelmq.io/too-many-requests');
    expect(apiErr.title).toBe('Too Many Requests');
    expect(apiErr.detail).toBe('Workspace rate limit exceeded');
    expect(apiErr.instance).toBe('/v1/events');
    expect(apiErr.errors).toEqual(['Quota exceeded for FREE plan']);
    expect(apiErr.retryAfterSec).toBe(12);
    expect(apiErr.requestId).toBe('req-abc-123');

    await expect(
      client.events.send({ event: 'order.paid', payload: {} }),
    ).rejects.toBeInstanceOf(KestrelTimeoutError);
  });
});
