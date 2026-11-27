import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { DeliveryJobPayload } from '../../common/queue/queue.constants.js';
import {
  DeliveryStatus,
  IntegrationChannel,
  IntegrationProvider,
  SchemaValidationMode,
} from '../../generated/prisma/enums.js';
import { type MatchedRoutingRuleRecord, RulesService } from '../rules/rules.service.js';
import type { EventSchemasService } from '../schemas/event-schemas.service.js';
import { BulkEventsService } from './bulk-events.service.js';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function buildMultipartRequest(
  csvContent: string,
  boundary = '----KestrelBulkBoundary',
  extraHeaders: Record<string, string> = {},
): Readable & { headers: Record<string, string> } {
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="events.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${csvContent}\r\n` +
    `--${boundary}--\r\n`;

  const buf = Buffer.from(body, 'utf8');
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += 64) {
    chunks.push(buf.subarray(i, i + 64));
  }

  const stream = Readable.from(chunks) as Readable & { headers: Record<string, string> };
  stream.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    ...extraHeaders,
  };
  return stream;
}

function createHarness(options?: {
  existingIdempotencyKeys?: readonly string[];
  matchingRules?: readonly MatchedRoutingRuleRecord[];
}) {
  const existingKeys = new Set(options?.existingIdempotencyKeys ?? []);
  const eventCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const deliveryCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const eventFindMany = vi.fn(async (args: { where: { idempotencyKey: { in: string[] } } }) =>
    args.where.idempotencyKey.in
      .filter((k) => existingKeys.has(k))
      .map((k) => ({ idempotencyKey: k })),
  );

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      event: {
        findMany: eventFindMany,
        createMany: eventCreateMany,
      },
      delivery: {
        createMany: deliveryCreateMany,
      },
    }),
  );

  const validatePayload = vi.fn(
    async (_wsId: string, eventName: string, payload: Record<string, unknown>) => {
      if (eventName === 'strict.event' && typeof payload['amount'] !== 'number') {
        throw new BadRequestException(['payload/amount must be number (type)']);
      }
      if (eventName === 'warn.event') {
        return {
          valid: false,
          mode: SchemaValidationMode.WARN,
          warnings: [
            {
              instancePath: '/note',
              schemaPath: '#/properties/note/type',
              keyword: 'type',
              message: 'must be string',
            },
          ],
        };
      }
      return {
        valid: true,
        mode: SchemaValidationMode.DISABLED,
        warnings: null,
      };
    },
  );

  const defaultRule: MatchedRoutingRuleRecord = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceId: WORKSPACE_ID,
    eventName: '*',
    integrationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    templateId: null,
    targetOverride: null,
    isActive: true,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    integration: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      channel: IntegrationChannel.EMAIL,
      provider: IntegrationProvider.MAILGUN,
      isActive: true,
    },
    template: null,
  };

  const rulesService = new RulesService({} as unknown as PrismaService);
  vi.spyOn(rulesService, 'findMatchingRules').mockResolvedValue([
    ...(options?.matchingRules ?? [defaultRule]),
  ]);

  const addBulk = vi.fn().mockResolvedValue([]);

  const service = new BulkEventsService(
    { $transaction: transaction } as unknown as PrismaService,
    { validatePayload } as unknown as EventSchemasService,
    rulesService,
    { addBulk } as unknown as Queue<DeliveryJobPayload, unknown, string>,
  );

  return {
    service,
    transaction,
    eventFindMany,
    eventCreateMany,
    deliveryCreateMany,
    validatePayload,
    rulesService,
    addBulk,
  };
}

describe('BulkEventsService', () => {
  it('batches 1,200 valid rows in chunks of 500 (3 transactions + 3 BullMQ addBulk calls) and caches rules per eventName', async () => {
    const { service, transaction, eventCreateMany, deliveryCreateMany, rulesService, addBulk } =
      createHarness();

    const lines = ['event_name,recipient,payload,idempotency_key,deliver_at'];
    for (let i = 1; i <= 1_200; i += 1) {
      lines.push(
        `order.paid,"{""email"":""u${i}@example.com""}","{""seq"":${i}}",idem-${i},`,
      );
    }

    const req = buildMultipartRequest(lines.join('\n'));
    const result = await service.ingestMultipartStream(WORKSPACE_ID, req);

    expect(result).toEqual({
      totalRows: 1_200,
      importedEvents: 1_200,
      createdDeliveries: 1_200,
      skippedDuplicates: 0,
      failedRows: 0,
      errors: [],
    });

    expect(transaction).toHaveBeenCalledTimes(3);
    expect(eventCreateMany).toHaveBeenCalledTimes(3);
    expect(deliveryCreateMany).toHaveBeenCalledTimes(3);
    expect(addBulk).toHaveBeenCalledTimes(3);
    expect(addBulk.mock.calls[0]?.[0]).toHaveLength(500);
    expect(addBulk.mock.calls[1]?.[0]).toHaveLength(500);
    expect(addBulk.mock.calls[2]?.[0]).toHaveLength(200);
    // Rules queried only once for "order.paid" across all 1,200 rows
    expect(rulesService.findMatchingRules).toHaveBeenCalledTimes(1);
  });

  it('collects per-row validation errors, skips duplicate idempotency keys, and schedules future deliver_at jobs', async () => {
    const futureDate = new Date(Date.now() + 120_000).toISOString();
    const { service, eventCreateMany, deliveryCreateMany, addBulk } = createHarness({
      existingIdempotencyKeys: ['existing-key'],
    });

    const csv = [
      'event_name,recipient,payload,idempotency_key,deliver_at',
      `warn.event,"{""email"":""a@test.com""}","{""note"":123}",fresh-key,${futureDate}`,
      'order.paid,{},"{""ok"":true}",fresh-key,', // duplicate in same upload
      'order.paid,{},"{""ok"":true}",existing-key,', // duplicate in DB
      'bad name,{},"{""ok"":true}",,', // whitespace in event_name
      'order.paid,{},not-json,,', // invalid JSON payload
      'strict.event,{},"{""amount"":""nan""}",,', // STRICT schema failure
      'order.paid,{},"{""ok"":true}",,not-a-date', // invalid deliver_at
    ].join('\n');

    const req = buildMultipartRequest(csv);
    const result = await service.ingestMultipartStream(WORKSPACE_ID, req);

    expect(result.totalRows).toBe(7);
    expect(result.importedEvents).toBe(1);
    expect(result.createdDeliveries).toBe(1);
    expect(result.skippedDuplicates).toBe(2);
    expect(result.failedRows).toBe(4);
    expect(result.errors).toEqual([
      {
        row: 4,
        message: 'event_name must be a non-empty identifier (max 128 chars) without whitespace',
      },
      { row: 5, message: 'payload must be valid JSON' },
      { row: 6, message: 'payload/amount must be number (type)' },
      { row: 7, message: 'deliver_at must be a valid ISO-8601 timestamp' },
    ]);

    const createdEventBatch = eventCreateMany.mock.calls[0]?.[0]?.data as Record<string, unknown>[];
    expect(createdEventBatch).toHaveLength(1);
    expect(createdEventBatch[0]?.['schemaWarnings']).toBeDefined();

    const createdDeliveryBatch = deliveryCreateMany.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >[];
    expect(createdDeliveryBatch[0]?.['status']).toBe(DeliveryStatus.SCHEDULED);

    const enqueuedJobs = addBulk.mock.calls[0]?.[0] as { opts: { delay?: number } }[];
    expect(enqueuedJobs[0]?.opts.delay).toBeGreaterThan(0);
  });

  it('throws 413 PayloadTooLargeException when file size or row count exceeds safety limits', async () => {
    const { service } = createHarness();
    const csv = ['event_name,payload', 'order.paid,"{""id"":1}"', 'order.paid,"{""id"":2}"'].join(
      '\n',
    );

    await expect(
      service.ingestMultipartStream(WORKSPACE_ID, buildMultipartRequest(csv), {
        maxFileBytes: 32,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    await expect(
      service.ingestMultipartStream(WORKSPACE_ID, buildMultipartRequest(csv), {
        maxRows: 1,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('throws 400 BadRequestException on wrong Content-Type, missing file part, or zero data rows', async () => {
    const { service } = createHarness();

    const badContentTypeReq = Readable.from(['{}']) as Readable & {
      headers: Record<string, string>;
    };
    badContentTypeReq.headers = { 'content-type': 'application/json' };

    await expect(
      service.ingestMultipartStream(WORKSPACE_ID, badContentTypeReq),
    ).rejects.toBeInstanceOf(BadRequestException);

    const boundary = '----EmptyFormBoundary';
    const fieldOnlyBody =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="note"\r\n\r\nhello\r\n` +
      `--${boundary}--\r\n`;
    const fieldOnlyReq = Readable.from([fieldOnlyBody]) as Readable & {
      headers: Record<string, string>;
    };
    fieldOnlyReq.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };

    await expect(service.ingestMultipartStream(WORKSPACE_ID, fieldOnlyReq)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const headerOnlyReq = buildMultipartRequest('event_name,payload\n');
    await expect(
      service.ingestMultipartStream(WORKSPACE_ID, headerOnlyReq),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
