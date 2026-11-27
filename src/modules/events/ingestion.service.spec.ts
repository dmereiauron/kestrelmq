import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  DELIVERY_JOB_NAMES,
  type DeliveryJobPayload,
  KESTREL_BACKOFF_TYPE,
} from '../../common/queue/queue.constants.js';
import type { RedisService } from '../../common/redis/redis.service.js';
import {
  DeliveryStatus,
  EventDirection,
  IntegrationChannel,
  IntegrationProvider,
  SchemaValidationMode,
} from '../../generated/prisma/enums.js';
import { type MatchedRoutingRuleRecord, RulesService } from '../rules/rules.service.js';
import type { EventSchemasService } from '../schemas/event-schemas.service.js';
import { BulkEventsService } from './bulk-events.service.js';
import { IngestEventDto } from './dto/ingest-event.dto.js';
import { EventsController } from './events.controller.js';
import { EVENT_IDEMPOTENCY_TTL_SEC, IngestionService } from './ingestion.service.js';

describe('IngestionService & EventsController', () => {
  let eventCreateMock: ReturnType<typeof vi.fn>;
  let eventFindFirstMock: ReturnType<typeof vi.fn>;
  let deliveryCreateMock: ReturnType<typeof vi.fn>;
  let transactionMock: ReturnType<typeof vi.fn>;
  let setNxExMock: ReturnType<typeof vi.fn>;
  let setExMock: ReturnType<typeof vi.fn>;
  let getMock: ReturnType<typeof vi.fn>;
  let compareAndDelMock: ReturnType<typeof vi.fn>;
  let validatePayloadMock: ReturnType<typeof vi.fn>;
  let findMatchingRulesMock: MockInstance<RulesService['findMatchingRules']>;
  let addBulkMock: ReturnType<typeof vi.fn>;

  let rulesService: RulesService;
  let service: IngestionService;
  let controller: EventsController;

  beforeEach(() => {
    eventCreateMock = vi.fn();
    eventFindFirstMock = vi.fn();
    deliveryCreateMock = vi.fn();

    const txClient = {
      event: { create: eventCreateMock },
      delivery: { create: deliveryCreateMock },
    };

    transactionMock = vi.fn(async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient));

    const prismaService = {
      $transaction: transactionMock,
      event: {
        findFirst: eventFindFirstMock,
      },
    } as unknown as PrismaService;

    setNxExMock = vi.fn().mockResolvedValue(true);
    setExMock = vi.fn().mockResolvedValue(undefined);
    getMock = vi.fn().mockResolvedValue(null);
    compareAndDelMock = vi.fn().mockResolvedValue(true);

    const redisService = {
      setNxEx: setNxExMock,
      setEx: setExMock,
      get: getMock,
      compareAndDel: compareAndDelMock,
    } as unknown as RedisService;

    validatePayloadMock = vi.fn().mockResolvedValue({
      valid: true,
      mode: SchemaValidationMode.DISABLED,
      warnings: null,
    });

    const eventSchemasService = {
      validatePayload: validatePayloadMock,
    } as unknown as EventSchemasService;

    rulesService = new RulesService({} as unknown as PrismaService);
    findMatchingRulesMock = vi.spyOn(rulesService, 'findMatchingRules').mockResolvedValue([]);

    addBulkMock = vi.fn().mockResolvedValue([]);
    const deliveriesQueue = {
      addBulk: addBulkMock,
    } as unknown as Queue<DeliveryJobPayload, unknown, string>;

    service = new IngestionService(
      prismaService,
      redisService,
      eventSchemasService,
      rulesService,
      deliveriesQueue,
    );
    const bulkEventsService = new BulkEventsService(
      prismaService,
      eventSchemasService,
      rulesService,
      deliveriesQueue,
    );
    controller = new EventsController(service, bulkEventsService);
  });

  it('ingests an event, fans out matching routing rules transactionally, enqueues BullMQ jobs, and responds 202 Accepted', async () => {
    const workspaceId = randomUUID();
    const eventId = randomUUID();
    const rule1Id = randomUUID();
    const rule2Id = randomUUID();
    const int1Id = randomUUID();
    const int2Id = randomUUID();
    const del1Id = randomUUID();
    const del2Id = randomUUID();
    const createdAt = new Date('2026-11-27T18:00:00.000Z');

    const rules: MatchedRoutingRuleRecord[] = [
      {
        id: rule1Id,
        workspaceId,
        eventName: 'order.paid',
        integrationId: int1Id,
        templateId: null,
        targetOverride: null,
        isActive: true,
        createdAt,
        integration: {
          id: int1Id,
          channel: IntegrationChannel.EMAIL,
          provider: IntegrationProvider.MAILGUN,
          isActive: true,
        },
        template: null,
      },
      {
        id: rule2Id,
        workspaceId,
        eventName: 'order.*',
        integrationId: int2Id,
        templateId: null,
        targetOverride: null,
        isActive: true,
        createdAt,
        integration: {
          id: int2Id,
          channel: IntegrationChannel.WEBHOOK,
          provider: IntegrationProvider.CUSTOM_WEBHOOK,
          isActive: true,
        },
        template: null,
      },
    ];

    findMatchingRulesMock.mockResolvedValueOnce(rules);
    eventCreateMock.mockResolvedValueOnce({
      id: eventId,
      workspaceId,
      idempotencyKey: 'idem-order-1',
      eventName: 'order.paid',
      recipient: { email: 'buyer@kestrelmq.io' },
      payload: { orderId: 'ord_100', amount: 79.5 },
      scheduledFor: null,
      schemaWarnings: null,
      direction: EventDirection.OUTBOUND,
      inboundSourceId: null,
      createdAt,
    });

    deliveryCreateMock
      .mockResolvedValueOnce({
        id: del1Id,
        routingRuleId: rule1Id,
        integrationId: int1Id,
        status: DeliveryStatus.PENDING,
        maxAttempts: 5,
      })
      .mockResolvedValueOnce({
        id: del2Id,
        routingRuleId: rule2Id,
        integrationId: int2Id,
        status: DeliveryStatus.PENDING,
        maxAttempts: 5,
      });

    const mockRes = { status: vi.fn() } as unknown as Response;

    const result = await controller.ingestEvent(
      workspaceId,
      {
        event: 'order.paid',
        recipient: { email: 'buyer@kestrelmq.io' },
        payload: { orderId: 'ord_100', amount: 79.5 },
      },
      'idem-order-1',
      mockRes,
    );

    expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.ACCEPTED);
    expect(result.eventId).toBe(eventId);
    expect(result.idempotentReplay).toBe(false);
    expect(result.deliveryIds).toEqual([del1Id, del2Id]);
    expect(result.deliveries).toHaveLength(2);
    expect(setNxExMock).toHaveBeenCalledWith(
      `idempotency:${workspaceId}:idem-order-1`,
      EVENT_IDEMPOTENCY_TTL_SEC,
      expect.stringMatching(/^PROCESSING:/),
    );
    expect(addBulkMock).toHaveBeenCalledOnce();
    expect(addBulkMock).toHaveBeenCalledWith([
      {
        name: DELIVERY_JOB_NAMES.DELIVER_OUTBOUND,
        data: { deliveryId: del1Id, workspaceId, eventId },
        opts: {
          jobId: del1Id,
          attempts: 5,
          backoff: { type: KESTREL_BACKOFF_TYPE },
        },
      },
      {
        name: DELIVERY_JOB_NAMES.DELIVER_OUTBOUND,
        data: { deliveryId: del2Id, workspaceId, eventId },
        opts: {
          jobId: del2Id,
          attempts: 5,
          backoff: { type: KESTREL_BACKOFF_TYPE },
        },
      },
    ]);
    expect(setExMock).toHaveBeenCalledWith(
      `idempotency:${workspaceId}:idem-order-1`,
      EVENT_IDEMPOTENCY_TTL_SEC,
      expect.any(String),
    );
  });

  it('supports scheduled delayed deliveries via deliverAt and records WARN schema warnings without blocking', async () => {
    const workspaceId = randomUUID();
    const eventId = randomUUID();
    const ruleId = randomUUID();
    const integrationId = randomUUID();
    const deliveryId = randomUUID();
    const futureDate = new Date(Date.now() + 120_000).toISOString();

    const warnings = [
      {
        instancePath: '/amount',
        schemaPath: '#/properties/amount/type',
        keyword: 'type',
        message: 'must be number',
      },
    ];

    validatePayloadMock.mockResolvedValueOnce({
      valid: false,
      mode: SchemaValidationMode.WARN,
      warnings,
    });

    findMatchingRulesMock.mockResolvedValueOnce([
      {
        id: ruleId,
        workspaceId,
        eventName: '*',
        integrationId,
        templateId: null,
        targetOverride: null,
        isActive: true,
        createdAt: new Date(),
        integration: {
          id: integrationId,
          channel: IntegrationChannel.WEBHOOK,
          provider: IntegrationProvider.CUSTOM_WEBHOOK,
          isActive: true,
        },
        template: null,
      },
    ]);

    eventCreateMock.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: eventId,
      ...data,
      idempotencyKey: null,
      createdAt: new Date(),
    }));

    deliveryCreateMock.mockResolvedValueOnce({
      id: deliveryId,
      routingRuleId: ruleId,
      integrationId,
      status: DeliveryStatus.SCHEDULED,
      maxAttempts: 5,
    });

    const response = await service.ingestEvent(workspaceId, {
      event: 'invoice.upcoming',
      payload: { amount: '99.00' },
      deliverAt: futureDate,
    });

    expect(response.deliveries[0]?.status).toBe(DeliveryStatus.SCHEDULED);
    expect(response.schemaWarnings).toEqual(warnings);
    expect(addBulkMock).toHaveBeenCalledOnce();

    const queuedJob = addBulkMock.mock.calls[0]![0][0] as {
      opts: { delay?: number };
    };
    expect(queuedJob.opts.delay).toBeGreaterThan(60_000);
  });

  it('rejects STRICT schema validation failures with 400 Bad Request and releases acquired Redis lock', async () => {
    const workspaceId = randomUUID();
    validatePayloadMock.mockRejectedValueOnce(
      new BadRequestException(['payload/email must match format "email" (format)']),
    );

    await expect(
      service.ingestEvent(
        workspaceId,
        {
          event: 'user.registered',
          payload: { email: 'not-an-email' },
        },
        'strict-key-1',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(compareAndDelMock).toHaveBeenCalledWith(
      `idempotency:${workspaceId}:strict-key-1`,
      expect.stringMatching(/^PROCESSING:/),
    );
    expect(transactionMock).not.toHaveBeenCalled();
    expect(addBulkMock).not.toHaveBeenCalled();
  });

  it('returns 200 OK with existing Event + deliveries on Redis idempotent replay or PostgreSQL P2002 race without re-queuing', async () => {
    const workspaceId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const ruleId = randomUUID();
    const integrationId = randomUUID();
    const createdAt = new Date('2026-11-27T18:10:00.000Z');

    const storedEventWithDeliveries = {
      id: eventId,
      workspaceId,
      idempotencyKey: 'dup-key-1',
      eventName: 'order.paid',
      scheduledFor: null,
      schemaWarnings: null,
      createdAt,
      deliveries: [
        {
          id: deliveryId,
          routingRuleId: ruleId,
          integrationId,
          status: DeliveryStatus.DELIVERED,
        },
      ],
    };

    // Case 1: Redis SET NX returns false -> returns existing DB record with 200 OK
    setNxExMock.mockResolvedValueOnce(false);
    eventFindFirstMock.mockResolvedValueOnce(storedEventWithDeliveries);

    const mockRes = { status: vi.fn() } as unknown as Response;
    const replay = await controller.ingestEvent(
      workspaceId,
      { event: 'order.paid', payload: { orderId: 'ord_1' } },
      'dup-key-1',
      mockRes,
    );

    expect(mockRes.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.eventId).toBe(eventId);
    expect(replay.deliveries[0]?.status).toBe(DeliveryStatus.DELIVERED);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(addBulkMock).not.toHaveBeenCalled();

    // Case 2: Redis key had expired (SET NX returns true), but PostgreSQL partial unique index throws P2002
    setNxExMock.mockResolvedValueOnce(true);
    transactionMock.mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));
    eventFindFirstMock.mockResolvedValueOnce(storedEventWithDeliveries);

    const pgRecovered = await service.ingestEvent(
      workspaceId,
      { event: 'order.paid', payload: { orderId: 'ord_1' } },
      'dup-key-1',
    );

    expect(pgRecovered.idempotentReplay).toBe(true);
    expect(pgRecovered.eventId).toBe(eventId);
    expect(addBulkMock).not.toHaveBeenCalled();

    // Case 3: In-flight PROCESSING lock with no committed DB record yet -> 409 Conflict
    setNxExMock.mockResolvedValueOnce(false);
    eventFindFirstMock.mockResolvedValueOnce(null);
    getMock.mockResolvedValueOnce('PROCESSING:still-running');

    await expect(
      service.ingestEvent(
        workspaceId,
        { event: 'order.paid', payload: { orderId: 'ord_1' } },
        'in-flight-key',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('validates IngestEventDto and rejects mismatched or blank idempotency keys', async () => {
    const workspaceId = randomUUID();

    await expect(
      service.ingestEvent(workspaceId, { event: 'order.paid', payload: {} }, '   '),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.ingestEvent(
        workspaceId,
        { event: 'order.paid', payload: {}, idempotencyKey: 'key-b' },
        'key-a',
      ),
    ).rejects.toThrow(BadRequestException);

    const validDto = plainToInstance(IngestEventDto, {
      event: 'order.paid',
      payload: { orderId: '1' },
      deliverAt: '2026-12-01T00:00:00.000Z',
    });
    expect(await validate(validDto)).toHaveLength(0);

    const invalidDto = plainToInstance(IngestEventDto, {
      event: 'bad whitespace',
      payload: 'not-an-object',
      deliverAt: 'not-a-date',
    });
    const errors = await validate(invalidDto);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
