import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { extractCurrentUser } from '../decorators/current-user.decorator.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import { RequestContextMiddleware } from './request-context.middleware.js';

describe('RequestContextMiddleware & extractCurrentUser', () => {
  it('preserves safe incoming x-request-id header and mirrors X-Request-Id response header', () => {
    const middleware = new RequestContextMiddleware();
    const req = {
      headers: { 'x-request-id': 'client-corr-id_42' },
    } as unknown as AuthenticatedRequest;
    const setHeader = vi.fn();
    const res = { setHeader } as unknown as Response;
    const next = vi.fn();

    middleware.use(req, res, next);

    expect(req.requestId).toBe('client-corr-id_42');
    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'client-corr-id_42');
    expect(next).toHaveBeenCalledOnce();
  });

  it('generates fresh UUID when x-request-id is absent or unsafe', () => {
    const middleware = new RequestContextMiddleware();
    const req = {
      headers: { 'x-request-id': 'bad header\r\ninjection' },
    } as unknown as AuthenticatedRequest;
    const setHeader = vi.fn();
    const res = { setHeader } as unknown as Response;
    const next = vi.fn();

    middleware.use(req, res, next);

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
    expect(next).toHaveBeenCalledOnce();
  });

  it('extractCurrentUser returns request.user or throws UnauthorizedException', () => {
    const validUser = {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'dev@kestrelmq.io',
      sessionId: '22222222-2222-4222-8222-222222222222',
    };
    const okCtx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: validUser }),
      }),
    } as unknown as ExecutionContext;

    expect(extractCurrentUser(okCtx)).toEqual(validUser);

    const missingCtx = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as unknown as ExecutionContext;

    expect(() => extractCurrentUser(missingCtx)).toThrow(UnauthorizedException);
  });
});
