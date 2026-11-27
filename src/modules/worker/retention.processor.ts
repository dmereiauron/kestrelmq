import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  type CleanupDeliveryAttemptsJobPayload,
  MAINTENANCE_JOB_NAMES,
  MAINTENANCE_QUEUE,
} from '../../common/queue/queue.constants.js';
import { WorkspacePlan } from '../../generated/prisma/enums.js';

export const RETENTION_DAYS_BY_PLAN: Readonly<Record<WorkspacePlan, number>> = {
  [WorkspacePlan.FREE]: 7,
  [WorkspacePlan.PRO]: 30,
  [WorkspacePlan.ENTERPRISE]: 90,
};

export const DAILY_RETENTION_CRON = '0 3 * * *' as const;
export const DEFAULT_RETENTION_BATCH_SIZE = 1_000;
export const DEFAULT_MAX_BATCHES_PER_PLAN = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const ORDERED_PLANS: readonly WorkspacePlan[] = [
  WorkspacePlan.FREE,
  WorkspacePlan.PRO,
  WorkspacePlan.ENTERPRISE,
];

export interface RetentionCleanupResult {
  readonly deletedByPlan: Readonly<Record<WorkspacePlan, number>>;
  readonly totalDeleted: number;
}

@Processor(MAINTENANCE_QUEUE, {
  concurrency: 1,
})
export class RetentionProcessor extends WorkerHost implements OnModuleInit {
  readonly #logger = new Logger(RetentionProcessor.name);
  readonly #prismaService: PrismaService;
  readonly #maintenanceQueue: Queue<
    CleanupDeliveryAttemptsJobPayload,
    RetentionCleanupResult,
    string
  >;

  constructor(
    prismaService: PrismaService,
    @InjectQueue(MAINTENANCE_QUEUE)
    maintenanceQueue: Queue<CleanupDeliveryAttemptsJobPayload, RetentionCleanupResult, string>,
  ) {
    super();
    this.#prismaService = prismaService;
    this.#maintenanceQueue = maintenanceQueue;
  }

  async onModuleInit(): Promise<void> {
    await this.#maintenanceQueue.upsertJobScheduler(
      MAINTENANCE_JOB_NAMES.CLEANUP_DELIVERY_ATTEMPTS,
      {
        pattern: DAILY_RETENTION_CRON,
      },
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
  }

  override async process(
    job: Job<CleanupDeliveryAttemptsJobPayload, RetentionCleanupResult, string>,
  ): Promise<RetentionCleanupResult> {
    const nowMs = job.data?.nowMs ?? Date.now();
    const batchSize = Math.max(1, job.data?.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE);
    const maxBatchesPerPlan = Math.max(
      1,
      job.data?.maxBatchesPerPlan ?? DEFAULT_MAX_BATCHES_PER_PLAN,
    );

    const deletedByPlan: Record<WorkspacePlan, number> = {
      [WorkspacePlan.FREE]: 0,
      [WorkspacePlan.PRO]: 0,
      [WorkspacePlan.ENTERPRISE]: 0,
    };

    let totalDeleted = 0;

    for (const plan of ORDERED_PLANS) {
      const retentionDays = RETENTION_DAYS_BY_PLAN[plan];
      const cutoffDate = new Date(nowMs - retentionDays * MS_PER_DAY);

      for (let batchIndex = 0; batchIndex < maxBatchesPerPlan; batchIndex += 1) {
        const expiredBatch = await this.#prismaService.deliveryAttempt.findMany({
          where: {
            createdAt: { lt: cutoffDate },
            delivery: {
              workspace: {
                plan,
              },
            },
          },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: batchSize,
        });

        if (expiredBatch.length === 0) {
          break;
        }

        const { count } = await this.#prismaService.deliveryAttempt.deleteMany({
          where: {
            id: {
              in: expiredBatch.map((item) => item.id),
            },
          },
        });

        deletedByPlan[plan] += count;
        totalDeleted += count;

        if (expiredBatch.length < batchSize) {
          break;
        }
      }
    }

    this.#logger.log(
      JSON.stringify({
        job: MAINTENANCE_JOB_NAMES.CLEANUP_DELIVERY_ATTEMPTS,
        totalDeleted,
        deletedByPlan,
      }),
    );

    return {
      deletedByPlan,
      totalDeleted,
    };
  }
}
