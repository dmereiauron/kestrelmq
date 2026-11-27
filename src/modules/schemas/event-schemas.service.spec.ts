import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { SchemaValidationMode } from '../../generated/prisma/enums.js';
import { InferSchemaDto } from './dto/infer-schema.dto.js';
import { UpdateEventSchemaDto } from './dto/update-event-schema.dto.js';
import { UpsertEventSchemaDto } from './dto/upsert-event-schema.dto.js';
import { EventSchemasController } from './event-schemas.controller.js';
import { EventSchemasService } from './event-schemas.service.js';
import { extractDotPaths, extractSchemaDotPaths } from './utils/extract-dot-paths.util.js';
import { inferJsonSchema } from './utils/infer-json-schema.util.js';

describe('EventSchemasService, inferJsonSchema & extractDotPaths', () => {
  let schemaUpsertMock: ReturnType<typeof vi.fn>;
  let schemaFindManyMock: ReturnType<typeof vi.fn>;
  let schemaFindFirstMock: ReturnType<typeof vi.fn>;
  let schemaFindUniqueMock: ReturnType<typeof vi.fn>;
  let schemaUpdateMock: ReturnType<typeof vi.fn>;
  let schemaDeleteManyMock: ReturnType<typeof vi.fn>;
  let service: EventSchemasService;
  let controller: EventSchemasController;

  beforeEach(() => {
    schemaUpsertMock = vi.fn();
    schemaFindManyMock = vi.fn();
    schemaFindFirstMock = vi.fn();
    schemaFindUniqueMock = vi.fn();
    schemaUpdateMock = vi.fn();
    schemaDeleteManyMock = vi.fn();

    const prismaService = {
      eventSchema: {
        upsert: schemaUpsertMock,
        findMany: schemaFindManyMock,
        findFirst: schemaFindFirstMock,
        findUnique: schemaFindUniqueMock,
        update: schemaUpdateMock,
        deleteMany: schemaDeleteManyMock,
      },
    } as unknown as PrismaService;

    service = new EventSchemasService(prismaService);
    controller = new EventSchemasController(service);
  });

  it('infers JSON Schema types, string formats, homogeneous/heterogeneous arrays, and strips forbidden prototype keys', () => {
    const sample = JSON.parse(
      JSON.stringify({
        orderId: randomUUID(),
        occurredAt: '2026-11-26T18:30:00Z',
        billingDate: '2026-11-26',
        receiptUrl: 'https://billing.kestrelmq.io/receipts/101',
        customer: {
          email: 'ada@kestrelmq.io',
          vip: true,
        },
        amount: 149.95,
        retryCount: 2,
        coupon: null,
        items: [
          { sku: 'PRO-PLAN', qty: 1, tag: 'annual' },
          { sku: 'ADDON', qty: 2 },
        ],
        mixedTags: ['alpha', 42],
        emptyList: [],
      }),
    ) as Record<string, unknown>;

    Object.defineProperty(sample, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });

    const inferred = inferJsonSchema(sample);

    expect(inferred.type).toBe('object');
    expect(inferred.additionalProperties).toBe(true);
    expect(Object.hasOwn(inferred.properties ?? {}, '__proto__')).toBe(false);
    expect(inferred.properties?.['orderId']).toEqual({ type: 'string', format: 'uuid' });
    expect(inferred.properties?.['occurredAt']).toEqual({ type: 'string', format: 'date-time' });
    expect(inferred.properties?.['billingDate']).toEqual({ type: 'string', format: 'date' });
    expect(inferred.properties?.['receiptUrl']).toEqual({ type: 'string', format: 'uri' });
    expect(inferred.properties?.['amount']).toEqual({ type: 'number' });
    expect(inferred.properties?.['retryCount']).toEqual({ type: 'integer' });
    expect(inferred.properties?.['coupon']).toEqual({ type: 'null' });
    expect(inferred.properties?.['emptyList']).toEqual({ type: 'array' });
    expect(inferred.properties?.['mixedTags']).toEqual({
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    });

    // Null property ('coupon') is optional while non-null keys are required
    expect(inferred.required).toContain('orderId');
    expect(inferred.required).not.toContain('coupon');

    // Homogeneous object array merges properties and intersects required keys ('sku', 'qty')
    const itemsSchema = inferred.properties?.['items'];
    expect(itemsSchema?.type).toBe('array');
    expect(itemsSchema?.items?.required).toEqual(['qty', 'sku']);
  });

  it('extracts sorted autocomplete dot-paths from both sample payloads and JSON Schemas', () => {
    const sample = {
      orderId: 'ord_1',
      customer: { email: 'user@example.com', profile: {} },
      items: [{ sku: 'SKU-1' }],
      tags: [],
    };

    const preview = controller.inferSchema({ samplePayload: sample });
    expect(preview.variables).toEqual([
      'customer.email',
      'customer.profile',
      'items.0.sku',
      'orderId',
      'tags',
    ]);

    expect(extractDotPaths(null)).toEqual([]);
    expect(extractSchemaDotPaths(null)).toEqual([]);
  });

  it('performs schema CRUD and rejects invalid custom JSON Schemas or whitespace event names', async () => {
    const workspaceId = randomUUID();
    const schemaId = randomUUID();
    const now = new Date();

    await expect(
      controller.upsertSchema(workspaceId, {
        eventName: 'bad name',
        samplePayload: { ok: true },
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      controller.upsertSchema(workspaceId, {
        eventName: 'order.paid',
        samplePayload: { ok: true },
        jsonSchema: { type: 'not-a-valid-json-schema-type' },
      }),
    ).rejects.toThrow(BadRequestException);

    schemaUpsertMock.mockImplementation(
      async ({ create }: { create: Record<string, unknown> }) => ({
        id: schemaId,
        ...create,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const saved = await controller.upsertSchema(workspaceId, {
      eventName: 'order.paid',
      samplePayload: { orderId: 'ord_1', customer: { email: 'buyer@example.com' } },
      validationMode: SchemaValidationMode.STRICT,
    });

    expect(saved.id).toBe(schemaId);
    expect(saved.validationMode).toBe(SchemaValidationMode.STRICT);
    expect(saved.variables).toEqual(['customer.email', 'orderId']);

    schemaFindManyMock.mockResolvedValueOnce([saved]);
    const listed = await controller.listSchemas(workspaceId);
    expect(listed).toHaveLength(1);

    schemaFindFirstMock.mockResolvedValueOnce(saved);
    schemaUpdateMock.mockResolvedValueOnce({
      ...saved,
      validationMode: SchemaValidationMode.WARN,
    });
    const updated = await controller.updateSchema(workspaceId, schemaId, {
      samplePayload: { orderId: 'ord_2', total: 99 },
      validationMode: SchemaValidationMode.WARN,
    });
    expect(updated.validationMode).toBe(SchemaValidationMode.WARN);

    schemaFindFirstMock.mockResolvedValueOnce(null);
    await expect(
      controller.updateSchema(workspaceId, randomUUID(), {
        validationMode: SchemaValidationMode.DISABLED,
      }),
    ).rejects.toThrow(NotFoundException);

    schemaDeleteManyMock.mockResolvedValueOnce({ count: 1 });
    await expect(controller.deleteSchema(workspaceId, schemaId)).resolves.toBeUndefined();

    schemaDeleteManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(controller.deleteSchema(workspaceId, randomUUID())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('validates event payloads in DISABLED, WARN, and STRICT Ajv runtime modes', async () => {
    const workspaceId = randomUUID();
    const schemaId = randomUUID();
    const updatedAt = new Date();
    const jsonSchema = {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        email: { type: 'string', format: 'email' },
        amount: { type: 'number' },
      },
      required: ['orderId', 'email', 'amount'],
      additionalProperties: false,
    };

    // 1. No schema configured -> DISABLED pass-through (via validatePayload alias)
    schemaFindUniqueMock.mockResolvedValueOnce(null);
    await expect(
      service.validatePayload(workspaceId, 'unregistered.event', { anything: 1 }),
    ).resolves.toEqual({
      valid: true,
      mode: SchemaValidationMode.DISABLED,
      warnings: null,
    });

    // 2. DISABLED mode -> skips validation even on invalid payload
    schemaFindUniqueMock.mockResolvedValueOnce({
      id: schemaId,
      workspaceId,
      eventName: 'order.paid',
      samplePayload: {},
      jsonSchema,
      validationMode: SchemaValidationMode.DISABLED,
      createdAt: updatedAt,
      updatedAt,
    });
    await expect(
      service.validateEventPayload(workspaceId, 'order.paid', { wrong: true }),
    ).resolves.toEqual({
      valid: true,
      mode: SchemaValidationMode.DISABLED,
      warnings: null,
    });

    // 3. WARN mode -> records structured warnings without throwing
    schemaFindUniqueMock.mockResolvedValueOnce({
      id: schemaId,
      workspaceId,
      eventName: 'order.paid',
      samplePayload: {},
      jsonSchema,
      validationMode: SchemaValidationMode.WARN,
      createdAt: updatedAt,
      updatedAt,
    });
    const warnResult = await service.validateEventPayload(workspaceId, 'order.paid', {
      orderId: 'ord_1',
      email: 'not-an-email',
    });
    expect(warnResult.valid).toBe(false);
    expect(warnResult.mode).toBe(SchemaValidationMode.WARN);
    expect(warnResult.warnings).not.toBeNull();
    expect(warnResult.warnings!.length).toBeGreaterThanOrEqual(2);

    // 4. STRICT mode (valid payload, hits compiled validator cache) -> passes
    schemaFindUniqueMock.mockResolvedValueOnce({
      id: schemaId,
      workspaceId,
      eventName: 'order.paid',
      samplePayload: {},
      jsonSchema,
      validationMode: SchemaValidationMode.STRICT,
      createdAt: updatedAt,
      updatedAt,
    });
    await expect(
      service.validateEventPayload(workspaceId, 'order.paid', {
        orderId: 'ord_1',
        email: 'valid@kestrelmq.io',
        amount: 49.99,
      }),
    ).resolves.toEqual({
      valid: true,
      mode: SchemaValidationMode.STRICT,
      warnings: null,
    });

    // 5. STRICT mode (invalid payload) -> throws 400 BadRequestException with detailed Ajv errors
    schemaFindUniqueMock.mockResolvedValueOnce({
      id: schemaId,
      workspaceId,
      eventName: 'order.paid',
      samplePayload: {},
      jsonSchema,
      validationMode: SchemaValidationMode.STRICT,
      createdAt: updatedAt,
      updatedAt,
    });

    let caughtError: unknown;
    try {
      await service.validateEventPayload(workspaceId, 'order.paid', {
        orderId: 'ord_1',
        email: 'bad-email',
        amount: 'not-a-number',
      });
    } catch (err: unknown) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    const responsePayload = (caughtError as BadRequestException).getResponse() as {
      message: string[];
    };
    expect(Array.isArray(responsePayload.message)).toBe(true);
    expect(responsePayload.message.some((msg) => msg.includes('format'))).toBe(true);
    expect(responsePayload.message.some((msg) => msg.includes('type'))).toBe(true);
  });

  it('validates InferSchemaDto, UpsertEventSchemaDto, and UpdateEventSchemaDto constraints', async () => {
    expect(
      await validate(plainToInstance(InferSchemaDto, { samplePayload: { a: 1 } })),
    ).toHaveLength(0);

    expect(
      await validate(
        plainToInstance(UpsertEventSchemaDto, {
          eventName: 'order.paid',
          samplePayload: { a: 1 },
          validationMode: SchemaValidationMode.WARN,
        }),
      ),
    ).toHaveLength(0);

    expect(
      await validate(
        plainToInstance(UpdateEventSchemaDto, {
          validationMode: SchemaValidationMode.STRICT,
        }),
      ),
    ).toHaveLength(0);
  });
});
