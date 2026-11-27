import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisService } from '../redis/redis.service.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

function createHttpContext(options: {
  headers?: Record<string, string | string[] | undefined>;
  workspaceId?: string;
  method?: string;
  url?: string;
  initialStatusCode?: number;
}) {
  const responseHeaders = new Map<string, string>();
  let currentStatus = options.initialStatusCode ?? HttpStatus.ACCEPTED;

  const mockResponse = {
    get statusCode() {
      return currentStatus;
    },
    status: vi.fn((code: number) => {
      currentStatus = code;
      return mockResponse;
    }),
    setHeader: vi.fn((name: string, value: string) => {
      responseHeaders.set(name.toLowerCase(), value);
    }),
  };

  const mockRequest = {
    headers: options.headers ?? {},
    workspaceId: options.workspaceId,
    method: options.method ?? 'POST',
    originalUrl: options.url ?? '/v1/events',
    url: options.url ?? '/v1/events',
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => mockRequest,
      getResponse: () => mockResponse,
    }),
  } as unknown as ExecutionContext;

  return { context, mockResponse, responseHeaders };
}

describe('IdempotencyInterceptor', () => {
  let setNxExMock: ReturnType<typeof vi.fn>;
  let getMock: ReturnType<typeof vi.fn>;
  let setExMock: ReturnType<typeof vi.fn>;
  let compareAndDelMock: ReturnType<typeof vi.fn>;
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    setNxExMock = vi.fn();
    getMock = vi.fn();
    setExMock = vi.fn().mockResolvedValue(undefined);
    compareAndDelMock = vi.fn().mockResolvedValue(true);

    const redisService = {
      setNxEx: setNxExMock,
      get: getMock,
      setEx: setExMock,
      compareAndDel: compareAndDelMock,
    } as unknown as RedisService;

    interceptor = new IdempotencyInterceptor(redisService);
  });

  it('passes through untouched when Idempotency-Key header is omitted', async () => {
    const { context } = createHttpContext({ headers: {} });
    const next: CallHandler = { handle: () => of({ ok: true }) };

    const result = await firstValueFrom(interceptor.intercept(context, next));
    expect(result).toEqual({ ok: true });
    expect(setNxExMock).not.toHaveBeenCalled();
  });

  it('rejects blank or oversized Idempotency-Key headers with 400 BadRequestException', () => {
    const { context: emptyCtx } = createHttpContext({
      headers: { 'idempotency-key': '   ' },
    });
    const next: CallHandler = { handle: () => of({ ok: true }) };

    expect(() => interceptor.intercept(emptyCtx, next)).toThrow(BadRequestException);

    const { context: longCtx } = createHttpContext({
      headers: { 'idempotency-key': 'k'.repeat(256) },
    });
    expect(() => interceptor.intercept(longCtx, next)).toThrow(BadRequestException);
  });

  it('acquires SET NX EX 86400 lock on first request, caches response, and replays 200 OK on duplicate', async () => {
    const workspaceId = randomUUID();
    const idemKey = `idem-${randomUUID()}`;
    const handlerSpy = vi.fn(() => of({ eventId: 'evt_1' }));
    const next: CallHandler = { handle: handlerSpy };

    setNxExMock.mockResolvedValueOnce(true);
    const first = createHttpContext({
      headers: { 'idempotency-key': idemKey },
      workspaceId,
    });

    const firstBody = await firstValueFrom(interceptor.intercept(first.context, next));
    expect(firstBody).toEqual({ eventId: 'evt_1' });
    expect(setNxExMock).toHaveBeenCalledWith(
      `idempotency:http:${workspaceId}:POST:/v1/events:${idemKey}`,
      86_400,
      expect.stringMatching(/^PROCESSING:/),
    );
    expect(setExMock).toHaveBeenCalledOnce();

    const cachedValue = setExMock.mock.calls[0]![2] as string;
    setNxExMock.mockResolvedValueOnce(false);
    getMock.mockResolvedValueOnce(cachedValue);

    const replay = createHttpContext({
      headers: { 'idempotency-key': [idemKey] },
      workspaceId,
    });
    const replayedBody = await firstValueFrom(interceptor.intercept(replay.context, next));

    expect(replayedBody).toEqual({ eventId: 'evt_1' });
    expect(replay.mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(replay.responseHeaders.get('x-idempotency-replayed')).toBe('true');
    expect(handlerSpy).toHaveBeenCalledOnce();
  });

  it('throws 409 ConflictException when concurrent PROCESSING lock is active and releases lock on error', async () => {
    const workspaceId = randomUUID();
    const idemKey = `idem-${randomUUID()}`;

    setNxExMock.mockResolvedValueOnce(false);
    getMock.mockResolvedValueOnce('PROCESSING:in-flight');

    const inFlight = createHttpContext({
      headers: { 'idempotency-key': idemKey },
      workspaceId,
    });
    await expect(
      firstValueFrom(interceptor.intercept(inFlight.context, { handle: () => of({}) })),
    ).rejects.toThrow(ConflictException);

    setNxExMock.mockResolvedValueOnce(true);
    const failing = createHttpContext({
      headers: { 'idempotency-key': idemKey },
      workspaceId,
    });
    await expect(
      firstValueFrom(
        interceptor.intercept(failing.context, {
          handle: () => throwError(() => new BadRequestException('Validation error')),
        }),
      ),
    ).rejects.toThrow(BadRequestException);

    expect(compareAndDelMock).toHaveBeenCalledOnce();
  });
});
