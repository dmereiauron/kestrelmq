import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { RedisService } from '../../common/redis/redis.service.js';

export type DependencyHealthState = 'up' | 'down';

export interface HealthCheckResponse {
  readonly status: 'ok';
  readonly timestamp: string;
  readonly checks: {
    readonly postgres: DependencyHealthState;
    readonly redis: DependencyHealthState;
  };
}

@Injectable()
export class HealthService {
  readonly #prismaService: PrismaService;
  readonly #redisService: RedisService;

  constructor(prismaService: PrismaService, redisService: RedisService) {
    this.#prismaService = prismaService;
    this.#redisService = redisService;
  }

  async check(): Promise<HealthCheckResponse> {
    const [postgresOutcome, redisOutcome] = await Promise.allSettled([
      this.#prismaService.$queryRaw`SELECT 1`,
      this.#redisService.ping(),
    ]);

    const postgresUp = postgresOutcome.status === 'fulfilled';
    const redisUp =
      redisOutcome.status === 'fulfilled' &&
      typeof redisOutcome.value === 'string' &&
      redisOutcome.value.toUpperCase() === 'PONG';

    if (!postgresUp || !redisUp) {
      const degraded: string[] = [];
      if (!postgresUp) {
        degraded.push('postgres');
      }
      if (!redisUp) {
        degraded.push('redis');
      }

      throw new ServiceUnavailableException(
        `Infrastructure health check failed for: ${degraded.join(', ')}`,
      );
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        postgres: 'up',
        redis: 'up',
      },
    };
  }
}
