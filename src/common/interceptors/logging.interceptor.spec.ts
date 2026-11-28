import {
  type CallHandler,
  type ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpCallFixture } from '../../modules/mcp/testing/mcp-context.fixture.js';
import { LoggingInterceptor } from './logging.interceptor.js';

function createHttpContext(options: {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  statusCode?: number;
}): ExecutionContext {
  const request = {
    requestId: 'req-trace-001',
    method: options.method ?? 'POST',
    originalUrl: options.url ?? '/v1/auth/login',
    url: options.url ?? '/v1/auth/login',
    headers: options.headers ?? {},
    query: options.query ?? {},
    body: options.body ?? {},
  };

  const response = {
    statusCode: options.statusCode ?? 200,
  };

  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('LoggingInterceptor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through non-HTTP contexts untouched', async () => {
    const interceptor = new LoggingInterceptor();
    const rpcContext = {
      getType: () => 'rpc',
    } as unknown as ExecutionContext;
    const handler: CallHandler = {
      handle: () => of('rpc-ok'),
    };

    const result = await firstValueFrom(interceptor.intercept(rpcContext, handler));
    expect(result).toBe('rpc-ok');
  });

  it('logs latency in ms, recursively masks all sensitive keys, and handles circular references', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const interceptor = new LoggingInterceptor();

    const rawSecret = randomBytes(16).toString('hex');
    const circularBody: Record<string, unknown> = {
      email: 'ops@kestrelmq.io',
      phone: '+15550199',
      password: rawSecret,
      apiKey: `kmq_live_${rawSecret}`,
      credentials: { providerUser: 'mailgun' },
      nested: {
        token: rawSecret,
        secret: rawSecret,
        privateKey: rawSecret,
      },
    };
    circularBody['self'] = circularBody;

    const context = createHttpContext({
      headers: {
        authorization: `Bearer ${rawSecret}`,
        'x-api-key': `kmq_live_${rawSecret}`,
        'user-agent': 'vitest',
      },
      query: { token: rawSecret, page: '1' },
      body: circularBody,
      statusCode: 201,
    });

    const handler: CallHandler = {
      handle: () =>
        of({
          accessToken: rawSecret,
          refreshToken: rawSecret,
          user: { email: 'ops@kestrelmq.io' },
        }),
    };

    const responseValue = await firstValueFrom(interceptor.intercept(context, handler));
    expect(responseValue).toBeDefined();
    expect(logSpy).toHaveBeenCalledOnce();

    const loggedRaw = logSpy.mock.calls[0]?.[0] as string;
    expect(loggedRaw).not.toContain(rawSecret);

    const parsed = JSON.parse(loggedRaw) as Record<string, unknown>;
    expect(parsed['requestId']).toBe('req-trace-001');
    expect(parsed['method']).toBe('POST');
    expect(parsed['url']).toBe('/v1/auth/login');
    expect(parsed['statusCode']).toBe(201);
    expect(typeof parsed['durationMs']).toBe('number');
    expect(parsed['durationMs'] as number).toBeGreaterThanOrEqual(0);

    const loggedBody = parsed['body'] as Record<string, unknown>;
    expect(loggedBody['email']).toBe('[REDACTED]');
    expect(loggedBody['phone']).toBe('[REDACTED]');
    expect(loggedBody['password']).toBe('[REDACTED]');
    expect(loggedBody['apiKey']).toBe('[REDACTED]');
    expect(loggedBody['credentials']).toBe('[REDACTED]');
    expect(loggedBody['self']).toBe('[Circular]');
    expect(loggedBody['nested']).toEqual({
      token: '[REDACTED]',
      secret: '[REDACTED]',
      privateKey: '[REDACTED]',
    });

    const loggedResponse = parsed['response'] as Record<string, unknown>;
    expect(loggedResponse['accessToken']).toBe('[REDACTED]');
    expect(loggedResponse['refreshToken']).toBe('[REDACTED]');
    expect((loggedResponse['user'] as Record<string, unknown>)['email']).toBe('[REDACTED]');
  });

  it('logs warning with statusCode and durationMs when downstream handler throws', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const interceptor = new LoggingInterceptor();

    const context = createHttpContext({ url: '/v1/workspaces/123/api-keys' });
    const handler: CallHandler = {
      handle: () => throwError(() => new ForbiddenException('Insufficient workspace permissions')),
    };

    await expect(firstValueFrom(interceptor.intercept(context, handler))).rejects.toThrow(
      ForbiddenException,
    );

    expect(warnSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed['statusCode']).toBe(403);
    expect(typeof parsed['durationMs']).toBe('number');
  });

  it('logs one masked line per MCP call with name, workspace and outcome, without the result', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const interceptor = new LoggingInterceptor();
    const rawSecret = randomBytes(16).toString('hex');
    const { executionContext } = createMcpCallFixture({
      name: 'send_event',
      input: { event: 'order.paid', payload: { token: rawSecret } },
      request: { requestId: 'req-mcp-7', workspaceId: 'ws-1' },
    });
    const handler: CallHandler = { handle: () => of({ secretResult: rawSecret }) };

    await firstValueFrom(interceptor.intercept(executionContext, handler));

    expect(logSpy).toHaveBeenCalledOnce();
    const logged = logSpy.mock.calls[0]?.[0] as string;
    expect(logged).not.toContain(rawSecret);
    const parsed = JSON.parse(logged) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      requestId: 'req-mcp-7',
      kind: 'tool',
      name: 'send_event',
      workspaceId: 'ws-1',
      outcome: 'ok',
      input: { event: 'order.paid', payload: { token: '[REDACTED]' } },
    });
    expect(parsed).not.toHaveProperty('response');
  });

  it('logs a warning with outcome error when an MCP call fails', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const interceptor = new LoggingInterceptor();
    const { executionContext } = createMcpCallFixture({ name: 'replay_delivery' });
    const handler: CallHandler = {
      handle: () => throwError(() => new ForbiddenException('nope')),
    };

    await expect(firstValueFrom(interceptor.intercept(executionContext, handler))).rejects.toThrow(
      ForbiddenException,
    );
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed['outcome']).toBe('error');
    expect(parsed['name']).toBe('replay_delivery');
  });
});
