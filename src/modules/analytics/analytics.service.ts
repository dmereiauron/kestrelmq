import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { RedisService } from '../../common/redis/redis.service.js';
import { DeliveryStatus } from '../../generated/prisma/enums.js';
import {
  ANALYTICS_WINDOWS,
  type AnalyticsWindow,
} from './dto/get-analytics-summary-query.dto.js';

export const ANALYTICS_CACHE_TTL_SEC = 60;
export const ANALYTICS_STAMPEDE_LOCK_TTL_SEC = 10;
const DEFAULT_STAMPEDE_POLL_ATTEMPTS = 5;
const DEFAULT_STAMPEDE_POLL_DELAY_MS = 40;

const WINDOW_DURATION_MS: Readonly<Record<AnalyticsWindow, number>> = {
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
};

export interface DeliveriesByStatusCounts {
  readonly DELIVERED: number;
  readonly FAILED: number;
  readonly RETRYING: number;
  readonly PENDING: number;
  readonly SCHEDULED: number;
  readonly PAUSED: number;
  readonly CANCELED: number;
}

export interface AnalyticsSummaryData {
  readonly workspaceId: string;
  readonly window: AnalyticsWindow;
  readonly from: string;
  readonly to: string;
  readonly totalEvents: number;
  readonly totalDeliveries: number;
  readonly deliveriesByStatus: DeliveriesByStatusCounts;
  readonly successRate: number;
  readonly avgDurationMs: number;
  readonly p95DurationMs: number;
}

export interface AnalyticsSummaryResponse extends AnalyticsSummaryData {
  readonly cached: boolean;
}

export interface GetAnalyticsSummaryOptions {
  readonly nowMs?: number;
  readonly pollAttempts?: number;
  readonly pollDelayMs?: number;
}

interface LatencyAggregateRow {
  readonly avgDurationMs: number | string | null;
  readonly p95DurationMs: number | string | null;
}

function roundTwoDecimals(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

function toFiniteNumberOrZero(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return roundTwoDecimals(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return roundTwoDecimals(parsed);
    }
  }
  return 0;
}

function isAnalyticsWindow(value: unknown): value is AnalyticsWindow {
  return typeof value === 'string' && (ANALYTICS_WINDOWS as readonly string[]).includes(value);
}

function parseCachedAnalyticsSummary(raw: string): AnalyticsSummaryData | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const statusMap = record['deliveriesByStatus'];
    if (
      typeof record['workspaceId'] !== 'string' ||
      !isAnalyticsWindow(record['window']) ||
      typeof record['from'] !== 'string' ||
      typeof record['to'] !== 'string' ||
      typeof record['totalEvents'] !== 'number' ||
      typeof record['totalDeliveries'] !== 'number' ||
      typeof record['successRate'] !== 'number' ||
      typeof record['avgDurationMs'] !== 'number' ||
      typeof record['p95DurationMs'] !== 'number' ||
      typeof statusMap !== 'object' ||
      statusMap === null
    ) {
      return null;
    }

    const counts = statusMap as Record<string, unknown>;
    return {
      workspaceId: record['workspaceId'],
      window: record['window'],
      from: record['from'],
      to: record['to'],
      totalEvents: record['totalEvents'],
      totalDeliveries: record['totalDeliveries'],
      deliveriesByStatus: {
        DELIVERED: Number(counts['DELIVERED'] ?? 0),
        FAILED: Number(counts['FAILED'] ?? 0),
        RETRYING: Number(counts['RETRYING'] ?? 0),
        PENDING: Number(counts['PENDING'] ?? 0),
        SCHEDULED: Number(counts['SCHEDULED'] ?? 0),
        PAUSED: Number(counts['PAUSED'] ?? 0),
        CANCELED: Number(counts['CANCELED'] ?? 0),
      },
      successRate: record['successRate'],
      avgDurationMs: record['avgDurationMs'],
      p95DurationMs: record['p95DurationMs'],
    };
  } catch {
    return null;
  }
}

@Injectable()
export class AnalyticsService {
  readonly #prismaService: PrismaService;
  readonly #redisService: RedisService;

  constructor(prismaService: PrismaService, redisService: RedisService) {
    this.#prismaService = prismaService;
    this.#redisService = redisService;
  }

  async getSummary(
    workspaceId: string,
    window: AnalyticsWindow = '24h',
    options: GetAnalyticsSummaryOptions = {},
  ): Promise<AnalyticsSummaryResponse> {
    const cacheKey = `analytics:summary:${workspaceId}:${window}`;
    const lockKey = `analytics:lock:${workspaceId}:${window}`;

    const cachedRaw = await this.#redisService.get(cacheKey);
    if (cachedRaw !== null) {
      const parsed = parseCachedAnalyticsSummary(cachedRaw);
      if (parsed !== null) {
        return {
          ...parsed,
          cached: true,
        };
      }
    }

    const lockToken = randomUUID();
    const lockAcquired = await this.#redisService.setNxEx(
      lockKey,
      ANALYTICS_STAMPEDE_LOCK_TTL_SEC,
      lockToken,
    );

    if (lockAcquired) {
      try {
        const fresh = await this.#computeSummaryFromDatabase(
          workspaceId,
          window,
          options.nowMs ?? Date.now(),
        );
        await this.#redisService.setEx(cacheKey, ANALYTICS_CACHE_TTL_SEC, JSON.stringify(fresh));
        return {
          ...fresh,
          cached: false,
        };
      } finally {
        await this.#redisService.compareAndDel(lockKey, lockToken);
      }
    }

    const pollAttempts = options.pollAttempts ?? DEFAULT_STAMPEDE_POLL_ATTEMPTS;
    const pollDelayMs = options.pollDelayMs ?? DEFAULT_STAMPEDE_POLL_DELAY_MS;

    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      if (pollDelayMs > 0) {
        await delay(pollDelayMs);
      }
      const populatedRaw = await this.#redisService.get(cacheKey);
      if (populatedRaw !== null) {
        const parsed = parseCachedAnalyticsSummary(populatedRaw);
        if (parsed !== null) {
          return {
            ...parsed,
            cached: true,
          };
        }
      }
    }

    const fallbackFresh = await this.#computeSummaryFromDatabase(
      workspaceId,
      window,
      options.nowMs ?? Date.now(),
    );
    return {
      ...fallbackFresh,
      cached: false,
    };
  }

  async #computeSummaryFromDatabase(
    workspaceId: string,
    window: AnalyticsWindow,
    nowMs: number,
  ): Promise<AnalyticsSummaryData> {
    const toDate = new Date(nowMs);
    const fromDate = new Date(nowMs - WINDOW_DURATION_MS[window]);

    const [totalEvents, statusGroups, latencyRows] = await Promise.all([
      this.#prismaService.event.count({
        where: {
          workspaceId,
          createdAt: { gte: fromDate },
        },
      }),
      this.#prismaService.delivery.groupBy({
        by: ['status'],
        where: {
          workspaceId,
          createdAt: { gte: fromDate },
        },
        _count: {
          _all: true,
        },
      }),
      this.#prismaService.$queryRaw<LatencyAggregateRow[]>`
        SELECT
          AVG(da."duration_ms")::float8 AS "avgDurationMs",
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY da."duration_ms")::float8 AS "p95DurationMs"
        FROM "delivery_attempts" da
        INNER JOIN "deliveries" d ON d."id" = da."delivery_id"
        WHERE d."workspace_id" = ${workspaceId}::uuid
          AND da."created_at" >= ${fromDate}
      `,
    ]);

    const mutableCounts: Record<DeliveryStatus, number> = {
      [DeliveryStatus.DELIVERED]: 0,
      [DeliveryStatus.FAILED]: 0,
      [DeliveryStatus.RETRYING]: 0,
      [DeliveryStatus.PENDING]: 0,
      [DeliveryStatus.SCHEDULED]: 0,
      [DeliveryStatus.PAUSED]: 0,
      [DeliveryStatus.CANCELED]: 0,
    };

    let totalDeliveries = 0;
    for (const group of statusGroups) {
      const count = group._count._all;
      mutableCounts[group.status] = count;
      totalDeliveries += count;
    }

    const successRate =
      totalDeliveries > 0
        ? roundTwoDecimals((mutableCounts[DeliveryStatus.DELIVERED] / totalDeliveries) * 100)
        : 0;

    const latencyRow = latencyRows[0];
    const avgDurationMs = toFiniteNumberOrZero(latencyRow?.avgDurationMs);
    const p95DurationMs = toFiniteNumberOrZero(latencyRow?.p95DurationMs);

    return {
      workspaceId,
      window,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      totalEvents,
      totalDeliveries,
      deliveriesByStatus: mutableCounts,
      successRate,
      avgDurationMs,
      p95DurationMs,
    };
  }
}
