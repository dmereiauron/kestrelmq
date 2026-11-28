import { ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { RedisService } from '../../common/redis/redis.service.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthService & HealthController', () => {
  function createHarness(options?: {
    postgresError?: Error;
    redisPing?: string;
    redisError?: Error;
  }) {
    const queryRaw = options?.postgresError
      ? vi.fn().mockRejectedValue(options.postgresError)
      : vi.fn().mockResolvedValue([{ '?column?': 1 }]);

    const ping = options?.redisError
      ? vi.fn().mockRejectedValue(options.redisError)
      : vi.fn().mockResolvedValue(options?.redisPing ?? 'PONG');

    const prismaService = {
      $queryRaw: queryRaw,
    } as unknown as PrismaService;

    const redisService = {
      ping,
    } as unknown as RedisService;

    const service = new HealthService(prismaService, redisService);
    const controller = new HealthController(service);

    return { service, controller, queryRaw, ping };
  }

  it('marks HealthController and check() with @Public() metadata and returns 200 OK when Postgres and Redis succeed', async () => {
    const reflector = new Reflector();
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, HealthController)).toBe(true);
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, HealthController.prototype.check)).toBe(true);

    const { controller, queryRaw, ping } = createHarness();
    const result = await controller.check();

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(ping).toHaveBeenCalledOnce();
    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({
      postgres: 'up',
      redis: 'up',
    });
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });

  it('throws 503 ServiceUnavailableException when PostgreSQL, Redis, or both fail', async () => {
    const pgDown = createHarness({ postgresError: new Error('Connection refused') });
    await expect(pgDown.controller.check()).rejects.toThrow(ServiceUnavailableException);
    await expect(pgDown.controller.check()).rejects.toThrow(/postgres/);

    const redisDown = createHarness({ redisError: new Error('ECONNREFUSED') });
    await expect(redisDown.controller.check()).rejects.toThrow(ServiceUnavailableException);
    await expect(redisDown.controller.check()).rejects.toThrow(/redis/);

    const unexpectedPong = createHarness({ redisPing: 'LOADING' });
    await expect(unexpectedPong.controller.check()).rejects.toThrow(ServiceUnavailableException);

    const bothDown = createHarness({
      postgresError: new Error('PG down'),
      redisError: new Error('Redis down'),
    });
    await expect(bothDown.controller.check()).rejects.toThrow(/postgres, redis/);
  });
});
