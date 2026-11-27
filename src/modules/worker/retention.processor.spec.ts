import type { Job, Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  type CleanupDeliveryAttemptsJobPayload,
  MAINTENANCE_JOB_NAMES,
} from '../../common/queue/queue.constants.js';
import { WorkspacePlan } from '../../generated/prisma/enums.js';
import {
  DAILY_RETENTION_CRON,
  type RetentionCleanupResult,
  RetentionProcessor,
} from './retention.processor.js';

function createHarness() {
  const findMany = vi.fn().mockResolvedValue([]);
  const deleteMany = vi.fn(async (args: { where: { id: { in: string[] } } }) => ({
    count: args.where.id.in.length,
  }));
  const upsertJobScheduler = vi.fn().mockResolvedValue({});

  const processor = new RetentionProcessor(
    {
      deliveryAttempt: {
        findMany,
        deleteMany,
      },
    } as unknown as PrismaService,
    {
      upsertJobScheduler,
    } as unknown as Queue<CleanupDeliveryAttemptsJobPayload, RetentionCleanupResult, string>,
  );

  return {
    processor,
    findMany,
    deleteMany,
    upsertJobScheduler,
  };
}

describe('RetentionProcessor', () => {
  it('registers daily cleanup-delivery-attempts repeatable job scheduler on module init', async () => {
    const { processor, upsertJobScheduler } = createHarness();

    await processor.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      MAINTENANCE_JOB_NAMES.CLEANUP_DELIVERY_ATTEMPTS,
      { pattern: DAILY_RETENTION_CRON },
      {
        name: MAINTENANCE_JOB_NAMES.CLEANUP_DELIVERY_ATTEMPTS,
        data: {},
        opts: {
          attempts: 3,
          removeOnComplete: { count: 30 },
          removeOnFail: { count: 100 },
        },
      },
    );
  });

  it('purges expired delivery_attempts per plan retention window (FREE 7d, PRO 30d, ENTERPRISE 90d) in bounded batches', async () => {
    const { processor, findMany, deleteMany } = createHarness();
    const fixedNow = Date.parse('2026-11-27T03:00:00.000Z');

    // FREE: 5 expired rows across 3 batches of size 2 ([2, 2, 1])
    // PRO: 2 expired rows across 2 batches ([2, 0])
    // ENTERPRISE: 1 expired row ([1])
    findMany
      .mockResolvedValueOnce([{ id: 'f-1' }, { id: 'f-2' }])
      .mockResolvedValueOnce([{ id: 'f-3' }, { id: 'f-4' }])
      .mockResolvedValueOnce([{ id: 'f-5' }])
      .mockResolvedValueOnce([{ id: 'p-1' }, { id: 'p-2' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'e-1' }]);

    const job = {
      name: MAINTENANCE_JOB_NAMES.CLEANUP_DELIVERY_ATTEMPTS,
      data: {
        nowMs: fixedNow,
        batchSize: 2,
        maxBatchesPerPlan: 10,
      },
    } as unknown as Job<CleanupDeliveryAttemptsJobPayload, RetentionCleanupResult, string>;

    const result = await processor.process(job);

    expect(result).toEqual({
      deletedByPlan: {
        [WorkspacePlan.FREE]: 5,
        [WorkspacePlan.PRO]: 2,
        [WorkspacePlan.ENTERPRISE]: 1,
      },
      totalDeleted: 8,
    });

    // Verify exact plan retention cutoffs:
    // FREE: 2026-11-20T03:00:00.000Z (7d)
    // PRO: 2026-10-28T03:00:00.000Z (30d)
    // ENTERPRISE: 2026-08-29T03:00:00.000Z (90d)
    expect(findMany.mock.calls[0]?.[0]).toEqual({
      where: {
        createdAt: { lt: new Date('2026-11-20T03:00:00.000Z') },
        delivery: { workspace: { plan: WorkspacePlan.FREE } },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    expect(findMany.mock.calls[3]?.[0]).toEqual({
      where: {
        createdAt: { lt: new Date('2026-10-28T03:00:00.000Z') },
        delivery: { workspace: { plan: WorkspacePlan.PRO } },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    expect(findMany.mock.calls[5]?.[0]).toEqual({
      where: {
        createdAt: { lt: new Date('2026-08-29T03:00:00.000Z') },
        delivery: { workspace: { plan: WorkspacePlan.ENTERPRISE } },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });

    expect(deleteMany).toHaveBeenCalledTimes(5);
  });

  it('performs no deletes when no expired delivery_attempts exist and respects maxBatchesPerPlan ceiling', async () => {
    const emptyHarness = createHarness();
    const emptyJob = {
      name: MAINTENANCE_JOB_NAMES.CLEANUP_DELIVERY_ATTEMPTS,
      data: { nowMs: Date.now() },
    } as unknown as Job<CleanupDeliveryAttemptsJobPayload, RetentionCleanupResult, string>;

    const emptyResult = await emptyHarness.processor.process(emptyJob);
    expect(emptyResult.totalDeleted).toBe(0);
    expect(emptyHarness.deleteMany).not.toHaveBeenCalled();

    const cappedHarness = createHarness();
    cappedHarness.findMany.mockResolvedValue([{ id: 'row-a' }, { id: 'row-b' }]);
    const cappedJob = {
      name: MAINTENANCE_JOB_NAMES.CLEANUP_DELIVERY_ATTEMPTS,
      data: { nowMs: Date.now(), batchSize: 2, maxBatchesPerPlan: 2 },
    } as unknown as Job<CleanupDeliveryAttemptsJobPayload, RetentionCleanupResult, string>;

    const cappedResult = await cappedHarness.processor.process(cappedJob);
    // 3 plans * 2 batches * 2 rows = 12 rows max
    expect(cappedResult.totalDeleted).toBe(12);
    expect(cappedHarness.deleteMany).toHaveBeenCalledTimes(6);
  });
});
