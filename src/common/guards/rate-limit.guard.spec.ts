import {
  type ExecutionContext,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import { WorkspacePlan } from '../../generated/prisma/enums.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RedisService, SlidingWindowRateLimitResult } from '../redis/redis.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';

function createHarness(overrides?: {
  windowMs?: number;
  freeMax?: number;
  proMax?: number;
  enterpriseMax?: number;
  cachedPlan?: string | null;
  dbPlan?: WorkspacePlan | null;
  rateLimitResult?: SlidingWindowRateLimitResult;
}) {
  const headers = new Map<string, string>();
  const setHeader = vi.fn((name: string, value: string) => {
    headers.set(name, value);
  });

  const redisGet = vi.fn().mockResolvedValue(overrides?.cachedPlan ?? null);
  const redisSetEx = vi.fn().mockResolvedValue(undefined);
  const checkSlidingWindowRateLimit = vi.fn().mockResolvedValue(
    overrides?.rateLimitResult ?? {
      allowed: true,
      currentCount: 1,
      retryAfterMs: 0,
    },
  );

  const findUniqueWorkspace = vi.fn().mockResolvedValue(
    overrides?.dbPlan === null
      ? null
      : { plan: overrides?.dbPlan ?? WorkspacePlan.FREE },
  );

  const configMap: Record<string, number> = {
    RATE_LIMIT_WINDOW_MS: overrides?.windowMs ?? 60_000,
    RATE_LIMIT_FREE_MAX: overrides?.freeMax ?? 60,
    RATE_LIMIT_PRO_MAX: overrides?.proMax ?? 600,
    RATE_LIMIT_ENTERPRISE_MAX: overrides?.enterpriseMax ?? 3_000,
  };

  const configService = {
    get: vi.fn((key: string) => configMap[key]),
  } as unknown as ConfigService<EnvConfig, true>;

  const guard = new RateLimitGuard(
    {
      get: redisGet,
      setEx: redisSetEx,
      checkSlidingWindowRateLimit,
    } as unknown as RedisService,
    {
      workspace: {
        findUnique: findUniqueWorkspace,
      },
    } as unknown as PrismaService,
    configService,
  );

  function buildContext(workspaceId?: string): ExecutionContext {
    const req = { workspaceId } as AuthenticatedRequest;
    const res = { setHeader } as unknown as Response;
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
  }

  return {
    guard,
    headers,
    setHeader,
    redisGet,
    redisSetEx,
    checkSlidingWindowRateLimit,
    findUniqueWorkspace,
    buildContext,
  };
}

describe('RateLimitGuard', () => {
  it('throws UnauthorizedException when workspaceId is missing from request context', async () => {
    const { guard, buildContext } = createHarness();

    await expect(guard.canActivate(buildContext(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('loads FREE workspace plan from DB on cache miss, caches it in Redis, and sets X-RateLimit headers', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const {
      guard,
      headers,
      redisGet,
      redisSetEx,
      findUniqueWorkspace,
      checkSlidingWindowRateLimit,
      buildContext,
    } = createHarness({
      cachedPlan: null,
      dbPlan: WorkspacePlan.FREE,
      freeMax: 60,
      windowMs: 60_000,
      rateLimitResult: {
        allowed: true,
        currentCount: 15,
        retryAfterMs: 0,
      },
    });

    const allowed = await guard.canActivate(buildContext(workspaceId));

    expect(allowed).toBe(true);
    expect(redisGet).toHaveBeenCalledWith(`workspace:plan:${workspaceId}`);
    expect(findUniqueWorkspace).toHaveBeenCalledWith({
      where: { id: workspaceId },
      select: { plan: true },
    });
    expect(redisSetEx).toHaveBeenCalledWith(
      `workspace:plan:${workspaceId}`,
      300,
      WorkspacePlan.FREE,
    );
    expect(checkSlidingWindowRateLimit).toHaveBeenCalledWith(
      `ratelimit:workspace:${workspaceId}`,
      60,
      60_000,
    );
    expect(headers.get('X-RateLimit-Limit')).toBe('60');
    expect(headers.get('X-RateLimit-Remaining')).toBe('45');
    expect(headers.has('Retry-After')).toBe(false);
  });

  it('uses cached PRO and ENTERPRISE plans without hitting PostgreSQL', async () => {
    const proWorkspaceId = '22222222-2222-4222-8222-222222222222';
    const proHarness = createHarness({
      cachedPlan: WorkspacePlan.PRO,
      proMax: 600,
      rateLimitResult: { allowed: true, currentCount: 200, retryAfterMs: 0 },
    });

    await expect(proHarness.guard.canActivate(proHarness.buildContext(proWorkspaceId))).resolves.toBe(
      true,
    );
    expect(proHarness.findUniqueWorkspace).not.toHaveBeenCalled();
    expect(proHarness.headers.get('X-RateLimit-Limit')).toBe('600');
    expect(proHarness.headers.get('X-RateLimit-Remaining')).toBe('400');

    const enterpriseWorkspaceId = '33333333-3333-4333-8333-333333333333';
    const entHarness = createHarness({
      cachedPlan: WorkspacePlan.ENTERPRISE,
      enterpriseMax: 3_000,
      rateLimitResult: { allowed: true, currentCount: 2_999, retryAfterMs: 0 },
    });

    await expect(
      entHarness.guard.canActivate(entHarness.buildContext(enterpriseWorkspaceId)),
    ).resolves.toBe(true);
    expect(entHarness.findUniqueWorkspace).not.toHaveBeenCalled();
    expect(entHarness.headers.get('X-RateLimit-Limit')).toBe('3000');
    expect(entHarness.headers.get('X-RateLimit-Remaining')).toBe('1');
  });

  it('falls back to FREE plan quota when workspace record is missing or cached value is corrupted', async () => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    const { guard, headers, redisSetEx, buildContext } = createHarness({
      cachedPlan: 'INVALID_PLAN',
      dbPlan: null,
      freeMax: 60,
      rateLimitResult: { allowed: true, currentCount: 1, retryAfterMs: 0 },
    });

    await expect(guard.canActivate(buildContext(workspaceId))).resolves.toBe(true);
    expect(redisSetEx).not.toHaveBeenCalled();
    expect(headers.get('X-RateLimit-Limit')).toBe('60');
    expect(headers.get('X-RateLimit-Remaining')).toBe('59');
  });

  it('throws 429 Too Many Requests with X-RateLimit-Remaining=0 and Retry-After header when quota is exceeded', async () => {
    const workspaceId = '55555555-5555-4555-8555-555555555555';
    const { guard, headers, buildContext } = createHarness({
      cachedPlan: WorkspacePlan.FREE,
      freeMax: 60,
      rateLimitResult: {
        allowed: false,
        currentCount: 60,
        retryAfterMs: 4_250,
      },
    });

    let caughtError: unknown;
    try {
      await guard.canActivate(buildContext(workspaceId));
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(HttpException);
    expect((caughtError as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(headers.get('X-RateLimit-Limit')).toBe('60');
    expect(headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(headers.get('Retry-After')).toBe('5');
  });
});
