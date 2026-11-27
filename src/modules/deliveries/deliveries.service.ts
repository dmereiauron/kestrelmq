import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  DELIVERIES_QUEUE,
  DELIVERY_JOB_NAMES,
  type DeliveryJobPayload,
  KESTREL_BACKOFF_TYPE,
} from '../../common/queue/queue.constants.js';
import { maskSensitiveData } from '../../common/utils/mask-sensitive.util.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  DeliveryStatus,
  EventDirection,
  type IntegrationChannel,
  type IntegrationProvider,
} from '../../generated/prisma/enums.js';
import type { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto.js';
import { decodeDeliveryCursor, encodeDeliveryCursor } from './utils/delivery-cursor.util.js';

export const DEFAULT_DELIVERIES_PAGE_LIMIT = 20;
export const MAX_DELIVERIES_PAGE_LIMIT = 100;

const CANCELABLE_STATUSES: ReadonlySet<DeliveryStatus> = new Set([
  DeliveryStatus.PENDING,
  DeliveryStatus.SCHEDULED,
  DeliveryStatus.RETRYING,
  DeliveryStatus.PAUSED,
]);

export interface DeliveryListItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly routingRuleId: string | null;
  readonly integrationId: string | null;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly event: {
    readonly id: string;
    readonly eventName: string;
    readonly direction: EventDirection;
    readonly scheduledFor: Date | null;
    readonly createdAt: Date;
  };
  readonly integration: {
    readonly id: string;
    readonly name: string;
    readonly channel: IntegrationChannel;
    readonly provider: IntegrationProvider;
  } | null;
}

export interface PaginatedDeliveriesResponse {
  readonly data: readonly DeliveryListItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface DeliveryAttemptAuditItem {
  readonly id: string;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly requestPayload: unknown;
  readonly responseStatus: number | null;
  readonly responseBody: string | null;
  readonly errorMessage: string | null;
  readonly durationMs: number;
  readonly createdAt: Date;
}

export interface DeliveryDetailResponse extends DeliveryListItem {
  readonly event: {
    readonly id: string;
    readonly eventName: string;
    readonly direction: EventDirection;
    readonly recipient: unknown;
    readonly payload: unknown;
    readonly scheduledFor: Date | null;
    readonly schemaWarnings: Prisma.JsonValue | null;
    readonly inboundSourceId: string | null;
    readonly createdAt: Date;
  };
  readonly integration: {
    readonly id: string;
    readonly name: string;
    readonly channel: IntegrationChannel;
    readonly provider: IntegrationProvider;
    readonly isActive: boolean;
  } | null;
  readonly routingRule: {
    readonly id: string;
    readonly eventName: string;
    readonly templateId: string | null;
    readonly targetOverride: string | null;
    readonly isActive: boolean;
  } | null;
  readonly attempts: readonly DeliveryAttemptAuditItem[];
}

export interface ReplayDeliveryResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: Date | null;
  readonly replayed: true;
  readonly jobId: string;
}

export interface CancelDeliveryResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly status: DeliveryStatus;
  readonly nextRetryAt: Date | null;
  readonly canceled: true;
  readonly removedFromQueue: boolean;
}

@Injectable()
export class DeliveriesService {
  readonly #prismaService: PrismaService;
  readonly #deliveriesQueue: Queue<DeliveryJobPayload, unknown, string>;

  constructor(
    prismaService: PrismaService,
    @InjectQueue(DELIVERIES_QUEUE) deliveriesQueue: Queue<DeliveryJobPayload, unknown, string>,
  ) {
    this.#prismaService = prismaService;
    this.#deliveriesQueue = deliveriesQueue;
  }

  async listDeliveries(
    workspaceId: string,
    query: ListDeliveriesQueryDto,
  ): Promise<PaginatedDeliveriesResponse> {
    const effectiveLimit = Math.min(
      MAX_DELIVERIES_PAGE_LIMIT,
      Math.max(1, query.limit ?? DEFAULT_DELIVERIES_PAGE_LIMIT),
    );

    const decodedCursor = query.cursor !== undefined ? decodeDeliveryCursor(query.cursor) : null;
    const trimmedEventName = query.eventName?.trim();

    const rows = await this.#prismaService.delivery.findMany({
      where: {
        workspaceId,
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.integrationId !== undefined ? { integrationId: query.integrationId } : {}),
        ...(trimmedEventName && trimmedEventName.length > 0
          ? { event: { eventName: trimmedEventName } }
          : {}),
        ...(decodedCursor !== null
          ? {
              OR: [
                { createdAt: { lt: decodedCursor.createdAt } },
                {
                  createdAt: decodedCursor.createdAt,
                  id: { lt: decodedCursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: effectiveLimit + 1,
      include: {
        event: {
          select: {
            id: true,
            eventName: true,
            direction: true,
            scheduledFor: true,
            createdAt: true,
          },
        },
        integration: {
          select: {
            id: true,
            name: true,
            channel: true,
            provider: true,
          },
        },
      },
    });

    const hasMore = rows.length > effectiveLimit;
    const pageRows = hasMore ? rows.slice(0, effectiveLimit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow !== undefined
        ? encodeDeliveryCursor({ createdAt: lastRow.createdAt, id: lastRow.id })
        : null;

    return {
      data: pageRows,
      nextCursor,
      hasMore,
    };
  }

  async getDeliveryById(
    workspaceId: string,
    deliveryId: string,
  ): Promise<DeliveryDetailResponse> {
    const delivery = await this.#prismaService.delivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId,
      },
      include: {
        event: {
          select: {
            id: true,
            eventName: true,
            direction: true,
            recipient: true,
            payload: true,
            scheduledFor: true,
            schemaWarnings: true,
            inboundSourceId: true,
            createdAt: true,
          },
        },
        integration: {
          select: {
            id: true,
            name: true,
            channel: true,
            provider: true,
            isActive: true,
          },
        },
        routingRule: {
          select: {
            id: true,
            eventName: true,
            templateId: true,
            targetOverride: true,
            isActive: true,
          },
        },
        attempts: {
          orderBy: [{ attemptNumber: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    return {
      id: delivery.id,
      workspaceId: delivery.workspaceId,
      eventId: delivery.eventId,
      routingRuleId: delivery.routingRuleId,
      integrationId: delivery.integrationId,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      maxAttempts: delivery.maxAttempts,
      nextRetryAt: delivery.nextRetryAt,
      deliveredAt: delivery.deliveredAt,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      event: {
        id: delivery.event.id,
        eventName: delivery.event.eventName,
        direction: delivery.event.direction,
        recipient: maskSensitiveData(delivery.event.recipient),
        payload: maskSensitiveData(delivery.event.payload),
        scheduledFor: delivery.event.scheduledFor,
        schemaWarnings: delivery.event.schemaWarnings,
        inboundSourceId: delivery.event.inboundSourceId,
        createdAt: delivery.event.createdAt,
      },
      integration: delivery.integration,
      routingRule: delivery.routingRule,
      attempts: delivery.attempts.map((attempt) => ({
        id: attempt.id,
        deliveryId: attempt.deliveryId,
        attemptNumber: attempt.attemptNumber,
        requestPayload: maskSensitiveData(attempt.requestPayload),
        responseStatus: attempt.responseStatus,
        responseBody: attempt.responseBody,
        errorMessage: attempt.errorMessage,
        durationMs: attempt.durationMs,
        createdAt: attempt.createdAt,
      })),
    };
  }

  async replayDelivery(
    workspaceId: string,
    deliveryId: string,
  ): Promise<ReplayDeliveryResponse> {
    const existing = await this.#prismaService.delivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId,
      },
      include: {
        event: {
          select: {
            id: true,
            direction: true,
          },
        },
      },
    });

    if (!existing) {
      throw new NotFoundException('Delivery not found');
    }

    await this.#removeJobByIdSafely(existing.id);

    const updated = await this.#prismaService.delivery.update({
      where: { id: existing.id },
      data: {
        status: DeliveryStatus.PENDING,
        nextRetryAt: null,
      },
      select: {
        id: true,
        workspaceId: true,
        eventId: true,
        status: true,
        attemptCount: true,
        maxAttempts: true,
        nextRetryAt: true,
      },
    });

    const jobName =
      existing.event.direction === EventDirection.INBOUND
        ? DELIVERY_JOB_NAMES.DELIVER_INBOUND
        : DELIVERY_JOB_NAMES.DELIVER_OUTBOUND;
    const replayJobId = `${existing.id}-replay-${randomUUID()}`;
    const totalAttemptsBudget = updated.attemptCount + updated.maxAttempts;

    await this.#deliveriesQueue.add(
      jobName,
      {
        deliveryId: updated.id,
        workspaceId: updated.workspaceId,
        eventId: updated.eventId,
      },
      {
        jobId: replayJobId,
        attempts: totalAttemptsBudget,
        backoff: {
          type: KESTREL_BACKOFF_TYPE,
        },
      },
    );

    return {
      id: updated.id,
      workspaceId: updated.workspaceId,
      eventId: updated.eventId,
      status: updated.status,
      attemptCount: updated.attemptCount,
      maxAttempts: updated.maxAttempts,
      nextRetryAt: updated.nextRetryAt,
      replayed: true,
      jobId: replayJobId,
    };
  }

  async cancelDelivery(
    workspaceId: string,
    deliveryId: string,
  ): Promise<CancelDeliveryResponse> {
    const existing = await this.#prismaService.delivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId,
      },
      select: {
        id: true,
        workspaceId: true,
        eventId: true,
        status: true,
      },
    });

    if (!existing) {
      throw new NotFoundException('Delivery not found');
    }

    if (!CANCELABLE_STATUSES.has(existing.status)) {
      throw new BadRequestException(
        `Cannot cancel delivery in ${existing.status} status; only uncompleted deliveries (PENDING, SCHEDULED, RETRYING, PAUSED) can be canceled`,
      );
    }

    const updated = await this.#prismaService.delivery.updateMany({
      where: {
        id: existing.id,
        workspaceId,
        status: {
          in: [...CANCELABLE_STATUSES],
        },
      },
      data: {
        status: DeliveryStatus.CANCELED,
        nextRetryAt: null,
      },
    });

    if (updated.count === 0) {
      const latest = await this.#prismaService.delivery.findFirst({
        where: { id: existing.id, workspaceId },
        select: { status: true },
      });
      if (!latest) {
        throw new NotFoundException('Delivery not found');
      }
      throw new BadRequestException(
        `Cannot cancel delivery in ${latest.status} status; delivery already reached a terminal state`,
      );
    }

    const removedFromQueue = await this.#removeJobByIdSafely(existing.id);

    return {
      id: existing.id,
      workspaceId: existing.workspaceId,
      eventId: existing.eventId,
      status: DeliveryStatus.CANCELED,
      nextRetryAt: null,
      canceled: true,
      removedFromQueue,
    };
  }

  async #removeJobByIdSafely(jobId: string): Promise<boolean> {
    try {
      const job = await this.#deliveriesQueue.getJob(jobId);
      if (!job) {
        return false;
      }

      if (typeof job.getState === 'function') {
        const state = await job.getState();
        if (state === 'completed' || state === 'failed' || state === 'active') {
          return false;
        }
      }

      await job.remove();
      return true;
    } catch {
      return false;
    }
  }
}
