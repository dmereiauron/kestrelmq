import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import type { ApiKeyGuard } from './api-key.guard.js';
import type { JwtAuthGuard } from './jwt-auth.guard.js';
import { JwtOrApiKeyGuard } from './jwt-or-api-key.guard.js';
import type { RolesGuard } from './roles.guard.js';

function createHttpContext(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  const request = { headers } as unknown as AuthenticatedRequest;
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('JwtOrApiKeyGuard', () => {
  let apiKeyCanActivateMock: ReturnType<typeof vi.fn>;
  let jwtCanActivateMock: ReturnType<typeof vi.fn>;
  let rolesCanActivateMock: ReturnType<typeof vi.fn>;
  let guard: JwtOrApiKeyGuard;

  beforeEach(() => {
    apiKeyCanActivateMock = vi.fn().mockResolvedValue(true);
    jwtCanActivateMock = vi.fn().mockResolvedValue(true);
    rolesCanActivateMock = vi.fn().mockResolvedValue(true);

    guard = new JwtOrApiKeyGuard(
      { canActivate: apiKeyCanActivateMock } as unknown as ApiKeyGuard,
      { canActivate: jwtCanActivateMock } as unknown as JwtAuthGuard,
      { canActivate: rolesCanActivateMock } as unknown as RolesGuard,
    );
  });

  it('delegates to ApiKeyGuard when Authorization Bearer contains a kmq_live_ key', async () => {
    const context = createHttpContext({
      authorization: 'Bearer kmq_live_abcdef1234567890',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyCanActivateMock).toHaveBeenCalledOnce();
    expect(jwtCanActivateMock).not.toHaveBeenCalled();
    expect(rolesCanActivateMock).not.toHaveBeenCalled();
  });

  it('delegates to ApiKeyGuard when x-api-key header is present', async () => {
    const context = createHttpContext({
      'x-api-key': ['kmq_live_header_token'],
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyCanActivateMock).toHaveBeenCalledOnce();
    expect(jwtCanActivateMock).not.toHaveBeenCalled();
  });

  it('delegates to JwtAuthGuard followed by RolesGuard for non-API-key Bearer JWT requests', async () => {
    const context = createHttpContext({
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'x-workspace-id': randomUUID(),
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyCanActivateMock).not.toHaveBeenCalled();
    expect(jwtCanActivateMock).toHaveBeenCalledOnce();
    expect(rolesCanActivateMock).toHaveBeenCalledOnce();
  });

  it('propagates JwtAuthGuard and RolesGuard rejections when API key is absent', async () => {
    jwtCanActivateMock.mockRejectedValueOnce(new UnauthorizedException('Missing token'));
    await expect(guard.canActivate(createHttpContext({}))).rejects.toThrow(UnauthorizedException);

    rolesCanActivateMock.mockRejectedValueOnce(new ForbiddenException('Forbidden'));
    await expect(
      guard.canActivate(
        createHttpContext({
          authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
