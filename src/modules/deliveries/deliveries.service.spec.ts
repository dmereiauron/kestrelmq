import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  DELIVERY_JOB_NAMES,
  type DeliveryJobPayload,
  KESTREL_BACKOFF_TYPE,
} from '../../common/queue/queue.constants.js';
import { REDACTED_VALUE } from '../../common/utils/mask-sensitive.util.js';
import {
  DeliveryStatus,
  EventDirection,
  IntegrationChannel,
  IntegrationProvider,
} from '../../generated/prisma/enums.js';
import { DeliveriesService } from './deliveries.service.js';
import { decodeDeliveryCursor, encodeDeliveryCursor } from './utils/delivery-cursor.util.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

function buildDeliveryRow(
  id: string,
  createdAtIso: string,
  status: DeliveryStatus = DeliveryStatus.DELIVERED,
) {
  const createdAt = new Date(createdAtIso);
  return {
    id,
    workspaceId: WORKSPACE_ID,
    eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    routingRuleId: 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr',
    integrationId: '99999999-9999-4999-8999-999999999999',
    status,
    attemptCount: 1,
    maxAttempts: 5,
    nextRetryAt: null,
    deliveredAt: status === DeliveryStatus.DELIVERED ? createdAt : null,
    createdAt,
    updatedAt: createdAt,
    event: {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      eventName: 'order.paid',
      direction: EventDirection.OUTBOUND,
      scheduledFor: null,
      createdAt,
    },
    integration: {
      id: '99999999-9999-4999-8999-999999999999',
      name: 'Primary Mailgun',
      channel: IntegrationChannel.EMAIL,
      provider: IntegrationProvider.MAILGUN,
    },
  };
}

function createHarness() {
  const findMany = vi.fn().mockResolvedValue([]);
  const findFirst = vi.fn().mockResolvedValue(null);
  const update = vi.fn();
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });

  const add = vi.fn().mockResolvedValue({});
  const getJob = vi.fn().mockResolvedValue(undefined);

  const service = new DeliveriesService(
    {
      delivery: {
        findMany,
        findFirst,
        update,
        updateMany,
      },
    } as unknown as PrismaService,
    {
      add,
      getJob,
    } as unknown as Queue<DeliveryJobPayload, unknown, string>,
  );

  return {
    service,
    findMany,
    findFirst,
    update,
    updateMany,
    add,
    getJob,
  };
}

describe('DeliveriesService & cursor utilities', () => {
  it('encodes and decodes Base64URL pagination cursors and rejects malformed cursors with 400', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const createdAt = new Date('2026-11-27T12:00:00.000Z');
    const encoded = encodeDeliveryCursor({ createdAt, id });

    const decoded = decodeDeliveryCursor(encoded);
    expect(decoded.id).toBe(id);
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());

    expect(() => decodeDeliveryCursor('')).toThrow(BadRequestException);
    expect(() => decodeDeliveryCursor('not-valid-json-base64!!!')).toThrow(BadRequestException);
    const badUuidCursor = Buffer.from(
      JSON.stringify({ createdAt: createdAt.toISOString(), id: 'not-a-uuid' }),
    ).toString('base64url');
    expect(() => decodeDeliveryCursor(badUuidCursor)).toThrow(BadRequestException);
  });

  it('paginates deliveries using strict keyset predicates (zero OFFSET/skip) with filters and lookahead limit + 1', async () => {
    const { service, findMany } = createHarness();
    const row1 = buildDeliveryRow(
      '33333333-3333-4333-8333-333333333333',
      '2026-11-27T10:00:00.000Z',
    );
    const row2 = buildDeliveryRow(
      '22222222-2222-4222-8222-222222222222',
      '2026-11-27T09:00:00.000Z',
    );
    const lookaheadRow = buildDeliveryRow(
      '11111111-1111-4111-8111-111111111112',
      '2026-11-27T08:00:00.000Z',
    );
    findMany.mockResolvedValueOnce([row1, row2, lookaheadRow]);

    const cursorDate = new Date('2026-11-27T11:00:00.000Z');
    const cursorId = '44444444-4444-4444-8444-444444444444';
    const incomingCursor = encodeDeliveryCursor({ createdAt: cursorDate, id: cursorId });

    const page = await service.listDeliveries(WORKSPACE_ID, {
      limit: 2,
      cursor: incomingCursor,
      status: DeliveryStatus.DELIVERED,
      eventName: 'order.paid',
      integrationId: '99999999-9999-4999-8999-999999999999',
    });

    expect(page.hasMore).toBe(true);
    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();

    const queryArg = findMany.mock.calls[0]?.[0] as Record<string, unknown>;
    // Strictly zero OFFSET / skip
    expect(queryArg['skip']).toBeUndefined();
    expect(queryArg['take']).toBe(3);
    expect(queryArg['orderBy']).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(queryArg['where']).toEqual({
      workspaceId: WORKSPACE_ID,
      status: DeliveryStatus.DELIVERED,
      integrationId: '99999999-9999-4999-8999-999999999999',
      event: { eventName: 'order.paid' },
      OR: [
        { createdAt: { lt: cursorDate } },
        { createdAt: cursorDate, id: { lt: cursorId } },
      ],
    });

    const nextDecoded = decodeDeliveryCursor(page.nextCursor!);
    expect(nextDecoded.id).toBe(row2.id);
    expect(nextDecoded.createdAt.toISOString()).toBe(row2.createdAt.toISOString());
  });

  it('returns delivery details with ordered attempts and recursively masks sensitive payload keys', async () => {
    const { service, findFirst } = createHarness();
    const deliveryId = '55555555-5555-4555-8555-555555555555';
    const createdAt = new Date('2026-11-27T10:00:00.000Z');

    findFirst.mockResolvedValueOnce({
      ...buildDeliveryRow(deliveryId, createdAt.toISOString(), DeliveryStatus.FAILED),
      event: {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        eventName: 'auth.reset',
        direction: EventDirection.OUTBOUND,
        recipient: { email: 'bob@example.com', apiKey: 'leak-1' },
        payload: { resetToken: 'leak-2', user: { name: 'Bob' } },
        scheduledFor: null,
        schemaWarnings: null,
        inboundSourceId: null,
        createdAt,
      },
      integration: {
        id: '99999999-9999-4999-8999-999999999999',
        name: 'Primary Mailgun',
        channel: IntegrationChannel.EMAIL,
        provider: IntegrationProvider.MAILGUN,
        isActive: true,
      },
      routingRule: null,
      attempts: [
        {
          id: 'a1111111-1111-4111-8111-111111111111',
          deliveryId,
          attemptNumber: 1,
          requestPayload: { target: 'bob@example.com', secret: 'leak-3' },
          responseStatus: 500,
          responseBody: 'Internal Error',
          errorMessage: 'HTTP 500',
          durationMs: 142,
          createdAt,
        },
      ],
    });

    const detail = await service.getDeliveryById(WORKSPACE_ID, deliveryId);

    expect(detail.event.recipient).toEqual({
      email: 'bob@example.com',
      apiKey: REDACTED_VALUE,
    });
    expect(detail.event.payload).toEqual({
      resetToken: REDACTED_VALUE,
      user: { name: 'Bob' },
    });
    expect(detail.attempts[0]?.requestPayload).toEqual({
      target: 'bob@example.com',
      secret: REDACTED_VALUE,
    });

    findFirst.mockResolvedValueOnce(null);
    await expect(service.getDeliveryById(WORKSPACE_ID, deliveryId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('replays a delivery by resetting status to PENDING, clearing nextRetryAt, and enqueueing a fresh BullMQ job', async () => {
    const { service, findFirst, update, add } = createHarness();
    const deliveryId = '66666666-6666-4666-8666-666666666666';

    findFirst.mockResolvedValueOnce({
      id: deliveryId,
      workspaceId: WORKSPACE_ID,
      eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      status: DeliveryStatus.FAILED,
      attemptCount: 5,
      maxAttempts: 5,
      event: {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        direction: EventDirection.OUTBOUND,
      },
    });

    update.mockResolvedValueOnce({
      id: deliveryId,
      workspaceId: WORKSPACE_ID,
      eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      status: DeliveryStatus.PENDING,
      attemptCount: 5,
      maxAttempts: 5,
      nextRetryAt: null,
    });

    const res = await service.replayDelivery(WORKSPACE_ID, deliveryId);

    expect(res.replayed).toBe(true);
    expect(res.status).toBe(DeliveryStatus.PENDING);
    expect(res.nextRetryAt).toBeNull();
    expect(res.jobId.startsWith(`${deliveryId}-replay-`)).toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: deliveryId },
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
    expect(add).toHaveBeenCalledWith(
      DELIVERY_JOB_NAMES.DELIVER_OUTBOUND,
      {
        deliveryId,
        workspaceId: WORKSPACE_ID,
        eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      },
      expect.objectContaining({
        jobId: res.jobId,
        attempts: 10,
        backoff: { type: KESTREL_BACKOFF_TYPE },
      }),
    );

    findFirst.mockResolvedValueOnce(null);
    await expect(service.replayDelivery(WORKSPACE_ID, deliveryId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('cancels uncompleted deliveries, removes pending/delayed BullMQ job, and rejects terminal statuses with 400', async () => {
    const { service, findFirst, updateMany, getJob } = createHarness();
    const deliveryId = '77777777-7777-4777-8777-777777777777';
    const removeJob = vi.fn().mockResolvedValue(undefined);

    for (const status of [
      DeliveryStatus.PENDING,
      DeliveryStatus.SCHEDULED,
      DeliveryStatus.RETRYING,
      DeliveryStatus.PAUSED,
    ]) {
      findFirst.mockResolvedValueOnce({
        id: deliveryId,
        workspaceId: WORKSPACE_ID,
        eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        status,
      });
      getJob.mockResolvedValueOnce({
        getState: vi.fn().mockResolvedValue('delayed'),
        remove: removeJob,
      });

      const canceled = await service.cancelDelivery(WORKSPACE_ID, deliveryId);
      expect(canceled.status).toBe(DeliveryStatus.CANCELED);
      expect(canceled.canceled).toBe(true);
      expect(canceled.removedFromQueue).toBe(true);
    }

    expect(updateMany).toHaveBeenCalledTimes(4);
    expect(removeJob).toHaveBeenCalledTimes(4);

    for (const terminalStatus of [
      DeliveryStatus.DELIVERED,
      DeliveryStatus.FAILED,
      DeliveryStatus.CANCELED,
    ]) {
      findFirst.mockResolvedValueOnce({
        id: deliveryId,
        workspaceId: WORKSPACE_ID,
        eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        status: terminalStatus,
      });

      await expect(service.cancelDelivery(WORKSPACE_ID, deliveryId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }

    findFirst.mockResolvedValueOnce(null);
    await expect(service.cancelDelivery(WORKSPACE_ID, deliveryId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
