import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { EnvConfig } from '../../config/env.validation.js';
import { WorkspacePlan } from '../../generated/prisma/enums.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

function isWorkspacePlan(value: string): value is WorkspacePlan {
  return (
    value === WorkspacePlan.FREE ||
    value === WorkspacePlan.PRO ||
    value === WorkspacePlan.ENTERPRISE
  );
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  static readonly PLAN_CACHE_TTL_SEC = 300;
  static readonly PLAN_CACHE_KEY_PREFIX = 'workspace:plan:' as const;
  static readonly RATE_LIMIT_KEY_PREFIX = 'ratelimit:workspace:' as const;

  readonly #redisService: RedisService;
  readonly #prismaService: PrismaService;
  readonly #windowMs: number;
  readonly #planQuotas: Readonly<Record<WorkspacePlan, number>>;

  constructor(
    redisService: RedisService,
    prismaService: PrismaService,
    configService: ConfigService<EnvConfig, true>,
  ) {
    this.#redisService = redisService;
    this.#prismaService = prismaService;
    this.#windowMs = configService.get('RATE_LIMIT_WINDOW_MS', { infer: true });
    this.#planQuotas = {
      [WorkspacePlan.FREE]: configService.get('RATE_LIMIT_FREE_MAX', { infer: true }),
      [WorkspacePlan.PRO]: configService.get('RATE_LIMIT_PRO_MAX', { infer: true }),
      [WorkspacePlan.ENTERPRISE]: configService.get('RATE_LIMIT_ENTERPRISE_MAX', { infer: true }),
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const workspaceId = request.workspaceId;
    if (!workspaceId) {
      throw new UnauthorizedException('Authenticated workspace context is required');
    }

    const plan = await this.#resolveWorkspacePlan(workspaceId);
    const maxRequests = this.#planQuotas[plan];
    const rateLimitKey = `${RateLimitGuard.RATE_LIMIT_KEY_PREFIX}${workspaceId}`;

    const result = await this.#redisService.checkSlidingWindowRateLimit(
      rateLimitKey,
      maxRequests,
      this.#windowMs,
    );

    const remaining = Math.max(0, maxRequests - result.currentCount);
    response.setHeader('X-RateLimit-Limit', String(maxRequests));
    response.setHeader('X-RateLimit-Remaining', String(remaining));

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
      response.setHeader('Retry-After', String(retryAfterSec));
      throw new HttpException('Workspace rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }

  async #resolveWorkspacePlan(workspaceId: string): Promise<WorkspacePlan> {
    const cacheKey = `${RateLimitGuard.PLAN_CACHE_KEY_PREFIX}${workspaceId}`;
    const cachedPlan = await this.#redisService.get(cacheKey);
    if (cachedPlan !== null && isWorkspacePlan(cachedPlan)) {
      return cachedPlan;
    }

    const workspace = await this.#prismaService.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true },
    });

    if (!workspace) {
      return WorkspacePlan.FREE;
    }

    await this.#redisService.setEx(cacheKey, RateLimitGuard.PLAN_CACHE_TTL_SEC, workspace.plan);
    return workspace.plan;
  }
}
