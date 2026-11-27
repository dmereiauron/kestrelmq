import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { RedisService } from '../../common/redis/redis.service.js';
import { DeliveryStatus } from '../../generated/prisma/enums.js';
import {
  ANALYTICS_CACHE_TTL_SEC,
  ANALYTICS_STAMPEDE_LOCK_TTL_SEC,
  AnalyticsService,
} from './analytics.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

function createHarness() {
  const countEvents = vi.fn().mockResolvedValue(42);
  const groupByDeliveries = vi.fn().mockResolvedValue([
    { status: DeliveryStatus.DELIVERED, _count: { _all: 30 } },
    { status: DeliveryStatus.FAILED, _count: { _all: 6 } },
    { status: DeliveryStatus.RETRYING, _count: { _all: 4 } },
  ]);
  const queryRaw = vi
    .fn()
    .mockResolvedValue([{ avgDurationMs: 124.567, p95DurationMs: 412.891 }]);

  const redisGet = vi.fn().mockResolvedValue(null);
  const redisSetEx = vi.fn().mockResolvedValue(undefined);
  const redisSetNxEx = vi.fn().mockResolvedValue(true);
  const redisCompareAndDel = vi.fn().mockResolvedValue(true);

  const service = new AnalyticsService(
    {
      event: { count: countEvents },
      delivery: { groupBy: groupByDeliveries },
      $queryRaw: queryRaw,
    } as unknown as PrismaService,
    {
      get: redisGet,
      setEx: redisSetEx,
      setNxEx: redisSetNxEx,
      compareAndDel: redisCompareAndDel,
    } as unknown as RedisService,
  );

  return {
    service,
    countEvents,
    groupByDeliveries,
    queryRaw,
    redisGet,
    redisSetEx,
    redisSetNxEx,
    redisCompareAndDel,
  };
}

describe('AnalyticsService', () => {
  it('computes summary on cache miss, stores in Redis with 60s TTL, and releases stampede lock', async () => {
    const {
      service,
      countEvents,
      groupByDeliveries,
      queryRaw,
      redisGet,
      redisSetEx,
      redisSetNxEx,
      redisCompareAndDel,
    } = createHarness();

    const fixedNow = Date.parse('2026-11-27T12:00:00.000Z');
    const summary = await service.getSummary(WORKSPACE_ID, '24h', { nowMs: fixedNow });

    expect(summary).toEqual({
      workspaceId: WORKSPACE_ID,
      window: '24h',
      from: '2026-11-26T12:00:00.000Z',
      to: '2026-11-27T12:00:00.000Z',
      totalEvents: 42,
      totalDeliveries: 40,
      deliveriesByStatus: {
        DELIVERED: 30,
        FAILED: 6,
        RETRYING: 4,
        PENDING: 0,
        SCHEDULED: 0,
        PAUSED: 0,
        CANCELED: 0,
      },
      successRate: 75,
      avgDurationMs: 124.57,
      p95DurationMs: 412.89,
      cached: false,
    });

    expect(redisGet).toHaveBeenCalledWith(`analytics:summary:${WORKSPACE_ID}:24h`);
    expect(redisSetNxEx).toHaveBeenCalledWith(
      `analytics:lock:${WORKSPACE_ID}:24h`,
      ANALYTICS_STAMPEDE_LOCK_TTL_SEC,
      expect.any(String),
    );
    expect(redisSetEx).toHaveBeenCalledWith(
      `analytics:summary:${WORKSPACE_ID}:24h`,
      ANALYTICS_CACHE_TTL_SEC,
      expect.any(String),
    );
    expect(redisCompareAndDel).toHaveBeenCalledWith(
      `analytics:lock:${WORKSPACE_ID}:24h`,
      expect.any(String),
    );
    expect(countEvents).toHaveBeenCalledTimes(1);
    expect(groupByDeliveries).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns cached summary immediately on Cache-Aside hit without querying PostgreSQL', async () => {
    const { service, countEvents, groupByDeliveries, queryRaw, redisGet, redisSetNxEx } =
      createHarness();

    const cachedPayload = {
      workspaceId: WORKSPACE_ID,
      window: '7d',
      from: '2026-11-20T12:00:00.000Z',
      to: '2026-11-27T12:00:00.000Z',
      totalEvents: 100,
      totalDeliveries: 100,
      deliveriesByStatus: {
        DELIVERED: 95,
        FAILED: 5,
        RETRYING: 0,
        PENDING: 0,
        SCHEDULED: 0,
        PAUSED: 0,
        CANCELED: 0,
      },
      successRate: 95,
      avgDurationMs: 88.2,
      p95DurationMs: 210.5,
    };

    redisGet.mockResolvedValueOnce(JSON.stringify(cachedPayload));

    const result = await service.getSummary(WORKSPACE_ID, '7d');

    expect(result.cached).toBe(true);
    expect(result.window).toBe('7d');
    expect(result.successRate).toBe(95);
    expect(redisSetNxEx).not.toHaveBeenCalled();
    expect(countEvents).not.toHaveBeenCalled();
    expect(groupByDeliveries).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('protects against cache stampede when lock is held and serves follower from populated cache', async () => {
    const { service, countEvents, redisGet, redisSetNxEx } = createHarness();

    const populatedByLeader = JSON.stringify({
      workspaceId: WORKSPACE_ID,
      window: '30d',
      from: '2026-10-28T12:00:00.000Z',
      to: '2026-11-27T12:00:00.000Z',
      totalEvents: 500,
      totalDeliveries: 500,
      deliveriesByStatus: {
        DELIVERED: 490,
        FAILED: 10,
        RETRYING: 0,
        PENDING: 0,
        SCHEDULED: 0,
        PAUSED: 0,
        CANCELED: 0,
      },
      successRate: 98,
      avgDurationMs: 92,
      p95DurationMs: 180,
    });

    // Initial check: cache miss; lock acquisition: false (held by leader); poll #2: populated!
    redisGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(populatedByLeader);
    redisSetNxEx.mockResolvedValueOnce(false);

    const followerResult = await service.getSummary(WORKSPACE_ID, '30d', {
      pollAttempts: 4,
      pollDelayMs: 0,
    });

    expect(followerResult.cached).toBe(true);
    expect(followerResult.totalEvents).toBe(500);
    expect(countEvents).not.toHaveBeenCalled();
  });

  it('falls back to DB computation and handles zero deliveries/attempts gracefully when stampede lock holder times out', async () => {
    const { service, countEvents, groupByDeliveries, queryRaw, redisGet, redisSetNxEx } =
      createHarness();

    redisGet.mockResolvedValue(null);
    redisSetNxEx.mockResolvedValueOnce(false);
    countEvents.mockResolvedValueOnce(0);
    groupByDeliveries.mockResolvedValueOnce([]);
    queryRaw.mockResolvedValueOnce([{ avgDurationMs: null, p95DurationMs: null }]);

    const result = await service.getSummary(WORKSPACE_ID, '24h', {
      pollAttempts: 2,
      pollDelayMs: 0,
    });

    expect(result.cached).toBe(false);
    expect(result.totalEvents).toBe(0);
    expect(result.totalDeliveries).toBe(0);
    expect(result.successRate).toBe(0);
    expect(result.avgDurationMs).toBe(0);
    expect(result.p95DurationMs).toBe(0);
  });
});
