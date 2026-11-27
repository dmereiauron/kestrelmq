import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  DEFAULT_DELIVERY_MAX_ATTEMPTS,
  DELIVERIES_QUEUE,
  DELIVERY_JOB_NAMES,
  type DeliveryJobPayload,
  KESTREL_BACKOFF_TYPE,
} from '../../common/queue/queue.constants.js';
import { RedisService } from '../../common/redis/redis.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { DeliveryStatus, EventDirection } from '../../generated/prisma/enums.js';
import {
  type EvaluableRule,
  type MatchedRoutingRuleRecord,
  RulesService,
} from '../rules/rules.service.js';
import { EventSchemasService } from '../schemas/event-schemas.service.js';
import type { IngestEventDto } from './dto/ingest-event.dto.js';

export const EVENT_IDEMPOTENCY_TTL_SEC = 86_400;
const PROCESSING_LOCK_PREFIX = 'PROCESSING:';
const MAX_IDEMPOTENCY_KEY_LEN = 255;

export interface IngestedDeliverySummary {
  readonly id: string;
  readonly routingRuleId: string | null;
  readonly integrationId: string | null;
  readonly status: DeliveryStatus;
  readonly scheduledFor: Date | null;
}

export interface IngestEventResponse {
  readonly eventId: string;
  readonly eventName: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string | null;
  readonly idempotentReplay: boolean;
  readonly scheduledFor: Date | null;
  readonly schemaWarnings: Prisma.JsonValue | null;
  readonly deliveryIds: readonly string[];
  readonly deliveries: readonly IngestedDeliverySummary[];
  readonly createdAt: Date;
}

interface EvaluableMatchedRule extends EvaluableRule {
  readonly record: MatchedRoutingRuleRecord;
}

function toPrismaJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

function parseCachedIngestResponse(raw: string): IngestEventResponse | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['eventId'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['eventName'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['workspaceId'] === 'string' &&
      Array.isArray((parsed as Record<string, unknown>)['deliveries'])
    ) {
      const record = parsed as Record<string, unknown>;
      const rawDeliveries = record['deliveries'] as Record<string, unknown>[];
      const deliveries: IngestedDeliverySummary[] = rawDeliveries.map((item) => ({
        id: String(item['id']),
        routingRuleId:
          typeof item['routingRuleId'] === 'string' ? item['routingRuleId'] : null,
        integrationId:
          typeof item['integrationId'] === 'string' ? item['integrationId'] : null,
        status: item['status'] as DeliveryStatus,
        scheduledFor:
          typeof item['scheduledFor'] === 'string' ? new Date(item['scheduledFor']) : null,
      }));

      return {
        eventId: record['eventId'] as string,
        eventName: record['eventName'] as string,
        workspaceId: record['workspaceId'] as string,
        idempotencyKey:
          typeof record['idempotencyKey'] === 'string' ? record['idempotencyKey'] : null,
        idempotentReplay: true,
        scheduledFor:
          typeof record['scheduledFor'] === 'string' ? new Date(record['scheduledFor']) : null,
        schemaWarnings: (record['schemaWarnings'] as Prisma.JsonValue | undefined) ?? null,
        deliveryIds: deliveries.map((d) => d.id),
        deliveries,
        createdAt:
          typeof record['createdAt'] === 'string' ? new Date(record['createdAt']) : new Date(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

@Injectable()
export class IngestionService {
  readonly #prismaService: PrismaService;
  readonly #redisService: RedisService;
  readonly #eventSchemasService: EventSchemasService;
  readonly #rulesService: RulesService;
  readonly #deliveriesQueue: Queue<DeliveryJobPayload, unknown, string>;

  constructor(
    prismaService: PrismaService,
    redisService: RedisService,
    eventSchemasService: EventSchemasService,
    rulesService: RulesService,
    @InjectQueue(DELIVERIES_QUEUE) deliveriesQueue: Queue<DeliveryJobPayload, unknown, string>,
  ) {
    this.#prismaService = prismaService;
    this.#redisService = redisService;
    this.#eventSchemasService = eventSchemasService;
    this.#rulesService = rulesService;
    this.#deliveriesQueue = deliveriesQueue;
  }

  async ingestEvent(
    workspaceId: string,
    dto: IngestEventDto,
    headerIdempotencyKey?: string,
  ): Promise<IngestEventResponse> {
    const eventName = dto.event.trim();
    if (eventName.length === 0 || /\s/.test(eventName)) {
      throw new BadRequestException(
        'event must be a non-empty identifier without whitespace',
      );
    }

    const idempotencyKey = this.#resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );

    const { scheduledFor, delayMs } = this.#parseSchedule(dto.deliverAt);
    const isDelayed = delayMs > 0;

    let redisKey: string | null = null;
    let lockToken: string | null = null;

    if (idempotencyKey !== null) {
      redisKey = `idempotency:${workspaceId}:${idempotencyKey}`;
      lockToken = `${PROCESSING_LOCK_PREFIX}${randomUUID()}`;

      const acquired = await this.#redisService.setNxEx(
        redisKey,
        EVENT_IDEMPOTENCY_TTL_SEC,
        lockToken,
      );

      if (!acquired) {
        return this.#resolveExistingIdempotentEvent(workspaceId, idempotencyKey, redisKey);
      }
    }

    try {
      const validation = await this.#eventSchemasService.validatePayload(
        workspaceId,
        eventName,
        dto.payload,
      );

      const candidateRules = await this.#rulesService.findMatchingRules(workspaceId, eventName);
      const evaluableRules: EvaluableMatchedRule[] = candidateRules.map((rule) => ({
        id: rule.id,
        eventName: rule.eventName,
        channel: rule.integration.channel,
        targetOverride: rule.targetOverride,
        isActive: rule.isActive,
        record: rule,
      }));

      const matchedRules = this.#rulesService.evaluateRules(evaluableRules, {
        eventName,
        payload: dto.payload,
        recipient: dto.recipient,
      });

      const initialStatus = isDelayed ? DeliveryStatus.SCHEDULED : DeliveryStatus.PENDING;
      const schemaWarningsJson =
        validation.warnings !== null && validation.warnings.length > 0
          ? toPrismaJsonValue(validation.warnings)
          : null;

      const persisted = await this.#prismaService.$transaction(async (tx) => {
        const createdEvent = await tx.event.create({
          data: {
            workspaceId,
            idempotencyKey,
            eventName,
            recipient: toPrismaJsonObject(dto.recipient ?? {}),
            payload: toPrismaJsonObject(dto.payload),
            scheduledFor,
            ...(schemaWarningsJson !== null ? { schemaWarnings: schemaWarningsJson } : {}),
            direction: EventDirection.OUTBOUND,
          },
        });

        const createdDeliveries: {
          id: string;
          routingRuleId: string | null;
          integrationId: string | null;
          status: DeliveryStatus;
          maxAttempts: number;
        }[] = [];

        for (const match of matchedRules) {
          const delivery = await tx.delivery.create({
            data: {
              workspaceId,
              eventId: createdEvent.id,
              routingRuleId: match.rule.record.id,
              integrationId: match.rule.record.integrationId,
              status: initialStatus,
              maxAttempts: DEFAULT_DELIVERY_MAX_ATTEMPTS,
            },
            select: {
              id: true,
              routingRuleId: true,
              integrationId: true,
              status: true,
              maxAttempts: true,
            },
          });
          createdDeliveries.push(delivery);
        }

        return {
          event: createdEvent,
          deliveries: createdDeliveries,
        };
      });

      if (persisted.deliveries.length > 0) {
        await this.#deliveriesQueue.addBulk(
          persisted.deliveries.map((delivery) => ({
            name: DELIVERY_JOB_NAMES.DELIVER_OUTBOUND,
            data: {
              deliveryId: delivery.id,
              workspaceId,
              eventId: persisted.event.id,
            },
            opts: {
              jobId: delivery.id,
              attempts: delivery.maxAttempts,
              backoff: {
                type: KESTREL_BACKOFF_TYPE,
              },
              ...(isDelayed ? { delay: delayMs } : {}),
            },
          })),
        );
      }

      const response = this.#formatResponse(
        persisted.event,
        persisted.deliveries,
        false,
      );

      if (redisKey !== null) {
        await this.#redisService.setEx(
          redisKey,
          EVENT_IDEMPOTENCY_TTL_SEC,
          JSON.stringify(response),
        );
      }

      return response;
    } catch (error: unknown) {
      if (idempotencyKey !== null && isPrismaUniqueConstraintError(error)) {
        const recovered = await this.#findEventByIdempotencyKey(workspaceId, idempotencyKey);
        if (recovered !== null) {
          if (redisKey !== null) {
            await this.#redisService.setEx(
              redisKey,
              EVENT_IDEMPOTENCY_TTL_SEC,
              JSON.stringify(recovered),
            );
          }
          return recovered;
        }
      }

      if (redisKey !== null && lockToken !== null) {
        await this.#redisService.compareAndDel(redisKey, lockToken);
      }

      throw error;
    }
  }

  #resolveIdempotencyKey(
    headerValue?: string,
    bodyValue?: string,
  ): string | null {
    let normalizedHeader: string | undefined;
    if (headerValue !== undefined) {
      const trimmed = headerValue.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_IDEMPOTENCY_KEY_LEN) {
        throw new BadRequestException(
          `Idempotency-Key must be between 1 and ${MAX_IDEMPOTENCY_KEY_LEN} non-whitespace characters`,
        );
      }
      normalizedHeader = trimmed;
    }

    let normalizedBody: string | undefined;
    if (bodyValue !== undefined) {
      const trimmed = bodyValue.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_IDEMPOTENCY_KEY_LEN) {
        throw new BadRequestException(
          `idempotencyKey must be between 1 and ${MAX_IDEMPOTENCY_KEY_LEN} non-whitespace characters`,
        );
      }
      normalizedBody = trimmed;
    }

    if (
      normalizedHeader !== undefined &&
      normalizedBody !== undefined &&
      normalizedHeader !== normalizedBody
    ) {
      throw new BadRequestException(
        'Idempotency-Key header and body idempotencyKey must match when both are provided',
      );
    }

    return normalizedHeader ?? normalizedBody ?? null;
  }

  #parseSchedule(deliverAt?: string): {
    readonly scheduledFor: Date | null;
    readonly delayMs: number;
  } {
    if (deliverAt === undefined) {
      return { scheduledFor: null, delayMs: 0 };
    }

    const parsed = new Date(deliverAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('deliverAt must be a valid ISO-8601 timestamp');
    }

    const delayMs = Math.max(0, parsed.getTime() - Date.now());
    return {
      scheduledFor: parsed,
      delayMs,
    };
  }

  async #resolveExistingIdempotentEvent(
    workspaceId: string,
    idempotencyKey: string,
    redisKey: string,
  ): Promise<IngestEventResponse> {
    const fromDatabase = await this.#findEventByIdempotencyKey(workspaceId, idempotencyKey);
    if (fromDatabase !== null) {
      await this.#redisService.setEx(
        redisKey,
        EVENT_IDEMPOTENCY_TTL_SEC,
        JSON.stringify(fromDatabase),
      );
      return fromDatabase;
    }

    const cachedRaw = await this.#redisService.get(redisKey);
    if (cachedRaw !== null && !cachedRaw.startsWith(PROCESSING_LOCK_PREFIX)) {
      const parsed = parseCachedIngestResponse(cachedRaw);
      if (parsed !== null) {
        return parsed;
      }
    }

    throw new ConflictException(
      'An identical request with this Idempotency-Key is currently being processed',
    );
  }

  async #findEventByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<IngestEventResponse | null> {
    const existing = await this.#prismaService.event.findFirst({
      where: {
        workspaceId,
        idempotencyKey,
      },
      include: {
        deliveries: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            routingRuleId: true,
            integrationId: true,
            status: true,
          },
        },
      },
    });

    if (!existing) {
      return null;
    }

    return this.#formatResponse(existing, existing.deliveries, true);
  }

  #formatResponse(
    event: {
      id: string;
      eventName: string;
      workspaceId: string;
      idempotencyKey: string | null;
      scheduledFor: Date | null;
      schemaWarnings: Prisma.JsonValue | null;
      createdAt: Date;
    },
    deliveries: readonly {
      id: string;
      routingRuleId: string | null;
      integrationId: string | null;
      status: DeliveryStatus;
    }[],
    idempotentReplay: boolean,
  ): IngestEventResponse {
    const summaries: IngestedDeliverySummary[] = deliveries.map((delivery) => ({
      id: delivery.id,
      routingRuleId: delivery.routingRuleId,
      integrationId: delivery.integrationId,
      status: delivery.status,
      scheduledFor: event.scheduledFor,
    }));

    return {
      eventId: event.id,
      eventName: event.eventName,
      workspaceId: event.workspaceId,
      idempotencyKey: event.idempotencyKey,
      idempotentReplay,
      scheduledFor: event.scheduledFor,
      schemaWarnings: event.schemaWarnings ?? null,
      deliveryIds: summaries.map((item) => item.id),
      deliveries: summaries,
      createdAt: event.createdAt,
    };
  }
}
