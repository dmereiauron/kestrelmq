import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

function buildExecutionContext(authHeader?: string): {
  context: ExecutionContext;
  request: AuthenticatedRequest;
} {
  const request = {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
  } as unknown as AuthenticatedRequest;

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;

  return { context, request };
}

describe('JwtAuthGuard', () => {
  let jwtService: JwtService;
  let accessSecret: string;
  let refreshSecret: string;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwtService = new JwtService();
    accessSecret = randomBytes(32).toString('hex');
    refreshSecret = randomBytes(32).toString('hex');

    const configService = {
      get: (key: string): unknown => (key === 'JWT_ACCESS_SECRET' ? accessSecret : undefined),
    } as unknown as ConfigService<EnvConfig, true>;

    guard = new JwtAuthGuard(jwtService, configService);
  });

  it('verifies a valid access JWT and attaches AuthenticatedUser to request', async () => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const token = await jwtService.signAsync(
      {
        sub: userId,
        email: 'engineer@kestrelmq.io',
        sid: sessionId,
        jti: randomUUID(),
        type: 'access',
      },
      { secret: accessSecret, expiresIn: 900 },
    );

    const { context, request } = buildExecutionContext(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.user).toEqual({
      userId,
      email: 'engineer@kestrelmq.io',
      sessionId,
    });
  });

  it('rejects missing header, API key prefix, refresh token type, or wrong signing secret', async () => {
    await expect(guard.canActivate(buildExecutionContext(undefined).context)).rejects.toThrow(
      UnauthorizedException,
    );

    await expect(
      guard.canActivate(buildExecutionContext('Basic dXNlcjpwYXNz').context),
    ).rejects.toThrow(UnauthorizedException);

    const fakeApiKey = `kmq_live_${randomBytes(24).toString('hex')}`;
    await expect(
      guard.canActivate(buildExecutionContext(`Bearer ${fakeApiKey}`).context),
    ).rejects.toThrow(UnauthorizedException);

    const wrongSecretToken = await jwtService.signAsync(
      {
        sub: randomUUID(),
        email: 'engineer@kestrelmq.io',
        sid: randomUUID(),
        jti: randomUUID(),
        type: 'access',
      },
      { secret: refreshSecret, expiresIn: 900 },
    );
    await expect(
      guard.canActivate(buildExecutionContext(`Bearer ${wrongSecretToken}`).context),
    ).rejects.toThrow(UnauthorizedException);

    const refreshTypeToken = await jwtService.signAsync(
      {
        sub: randomUUID(),
        email: 'engineer@kestrelmq.io',
        sid: randomUUID(),
        jti: randomUUID(),
        type: 'refresh',
      },
      { secret: accessSecret, expiresIn: 900 },
    );
    await expect(
      guard.canActivate(buildExecutionContext(`Bearer ${refreshTypeToken}`).context),
    ).rejects.toThrow(UnauthorizedException);
  });
});
