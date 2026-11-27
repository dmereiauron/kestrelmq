import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpCallFixture } from '../../modules/mcp/testing/mcp-context.fixture.js';
import { HttpExceptionFilter, type ProblemDetails } from './http-exception.filter.js';

function createMockHost(url = '/v1/auth/login') {
  let capturedStatus: number | undefined;
  let capturedContentType: string | undefined;
  let capturedBody: ProblemDetails | undefined;

  const response = {
    status: vi.fn((code: number) => {
      capturedStatus = code;
      return response;
    }),
    type: vi.fn((mime: string) => {
      capturedContentType = mime;
      return response;
    }),
    json: vi.fn((body: ProblemDetails) => {
      capturedBody = body;
      return response;
    }),
  };

  const request = {
    originalUrl: url,
    url,
    requestId: 'req-123',
  };

  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    getResult: () => ({
      status: capturedStatus,
      contentType: capturedContentType,
      body: capturedBody,
    }),
  };
}

describe('HttpExceptionFilter (RFC 9457)', () => {
  it('formats standard HttpException into RFC 9457 application/problem+json', () => {
    const filter = new HttpExceptionFilter();
    const { host, getResult } = createMockHost('/v1/workspaces');

    filter.catch(new UnauthorizedException('Invalid or expired access token'), host);

    const { status, contentType, body } = getResult();
    expect(status).toBe(401);
    expect(contentType).toBe('application/problem+json');
    expect(body).toBeDefined();
    expect(body?.type).toBe('https://errors.kestrelmq.io/unauthorized');
    expect(body?.title).toBe('Unauthorized');
    expect(body?.status).toBe(401);
    expect(body?.detail).toBe('Invalid or expired access token');
    expect(body?.instance).toBe('/v1/workspaces');
    expect(Number.isNaN(Date.parse(body?.timestamp ?? ''))).toBe(false);
  });

  it('aggregates ValidationPipe array messages into detail and errors extension', () => {
    const filter = new HttpExceptionFilter();
    const { host, getResult } = createMockHost('/v1/auth/register');

    const validationError = new BadRequestException({
      statusCode: 400,
      message: ['email must be an email', 'password must be longer than or equal to 8 characters'],
      error: 'Bad Request',
    });

    filter.catch(validationError, host);

    const { status, body } = getResult();
    expect(status).toBe(400);
    expect(body?.type).toBe('https://errors.kestrelmq.io/bad-request');
    expect(body?.title).toBe('Bad Request');
    expect(body?.detail).toBe(
      'email must be an email; password must be longer than or equal to 8 characters',
    );
    expect(body?.errors).toEqual([
      'email must be an email',
      'password must be longer than or equal to 8 characters',
    ]);
  });

  it('handles plain string HttpException responses and unmapped status codes cleanly', () => {
    const filter = new HttpExceptionFilter();
    const { host, getResult } = createMockHost('/v1/teapot');

    filter.catch(new HttpException('I am a teapot', 418), host);

    const { status, body } = getResult();
    expect(status).toBe(418);
    expect(body?.type).toBe('about:blank');
    expect(body?.title).toBe('HTTP Error');
    expect(body?.detail).toBe('I am a teapot');
  });

  it('masks unexpected non-HttpException errors into generic 500 Problem Details without leaking internals', () => {
    const filter = new HttpExceptionFilter();
    const { host, getResult } = createMockHost('/v1/events');

    filter.catch(new Error('SELECT * FROM users failed: connection reset'), host);

    const { status, contentType, body } = getResult();
    expect(status).toBe(500);
    expect(contentType).toBe('application/problem+json');
    expect(body?.type).toBe('https://errors.kestrelmq.io/internal-server-error');
    expect(body?.title).toBe('Internal Server Error');
    expect(body?.status).toBe(500);
    expect(body?.detail).toBe('An unexpected internal server error occurred');
    expect(body?.detail).not.toContain('SELECT');
  });

  describe('MCP calls', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rethrows HttpExceptions on an MCP host without writing an HTTP response', () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const filter = new HttpExceptionFilter();
      const { executionContext } = createMcpCallFixture({ name: 'inspect_delivery' });
      const exception = new NotFoundException('Delivery not found');

      expect(() => filter.catch(exception, executionContext)).toThrow(exception);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs unexpected MCP errors masked, then rethrows them unchanged', () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const filter = new HttpExceptionFilter();
      const { executionContext } = createMcpCallFixture({
        name: 'send_event',
        request: { requestId: 'req-mcp-1' },
      });
      const exception = Object.assign(new Error('boom'), { apiKey: 'kmq_live_should_not_leak' });

      expect(() => filter.catch(exception, executionContext)).toThrow(exception);
      expect(errorSpy).toHaveBeenCalledOnce();

      const logged = errorSpy.mock.calls[0]?.[0] as string;
      expect(logged).not.toContain('kmq_live_should_not_leak');
      const parsed = JSON.parse(logged) as Record<string, unknown>;
      expect(parsed['kind']).toBe('tool');
      expect(parsed['name']).toBe('send_event');
      expect(parsed['requestId']).toBe('req-mcp-1');
    });
  });
});
