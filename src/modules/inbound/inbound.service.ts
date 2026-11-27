import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomBytes, randomUUID } from 'node:crypto';
import { CryptoService } from '../../common/crypto/crypto.service.js';
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
import {
  DeliveryStatus,
  EventDirection,
  InboundProviderType,
} from '../../generated/prisma/enums.js';
import type { CreateInboundSourceDto } from './dto/create-inbound-source.dto.js';
import {
  type InboundHeadersMap,
  readHeaderCaseInsensitive,
  verifyInboundWebhookSignature,
} from './utils/inbound-signature.util.js';

const DEFAULT_INBOUND_MAX_RATE_PER_SEC = 10;
const INBOUND_RATE_WINDOW_MS = 1_000;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class InboundRateLimitExceededException extends HttpException {
  readonly retryAfterSec: number;

  constructor(retryAfterSec: number) {
    super('Inbound webhook rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    this.name = 'InboundRateLimitExceededException';
    this.retryAfterSec = Math.max(1, retryAfterSec);
  }
}

export interface InboundSourceResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly sourceSlug: string;
  readonly providerType: InboundProviderType;
  readonly hasSigningSecret: boolean;
  readonly targetUrl: string;
  readonly maxRatePerSec: number;
  readonly isPaused: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ResumeInboundSourceResponse {
  readonly source: InboundSourceResponse;
  readonly resumedDeliveriesCount: number;
}

export interface ReceiveInboundWebhookInput {
  readonly sourceSlug: string;
  readonly rawBody: Buffer | undefined;
  readonly headers: InboundHeadersMap;
  readonly parsedBody?: unknown;
  readonly nowMs?: number;
}

export interface ReceiveInboundWebhookResponse {
  readonly received: true;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly status: DeliveryStatus;
  readonly buffered: boolean;
}

interface StoredInboundSourceRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly sourceSlug: string;
  readonly providerType: InboundProviderType;
  readonly encryptedSigningSecret: string | null;
  readonly iv: string | null;
  readonly authTag: string | null;
  readonly targetUrl: string;
  readonly maxRatePerSec: number;
  readonly isPaused: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

function toPrismaJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function isValidHttpUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function generateSlugFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const suffix = randomBytes(4).toString('hex');
  return base.length > 0 ? `${base}-${suffix}` : `inbound-${suffix}`;
}

function normalizeInboundPayload(
  parsedBody: unknown,
  rawBody: Buffer,
): Record<string, unknown> {
  if (typeof parsedBody === 'object' && parsedBody !== null && !Array.isArray(parsedBody)) {
    return parsedBody as Record<string, unknown>;
  }

  if (Array.isArray(parsedBody)) {
    return { items: parsedBody };
  }

  if (rawBody.byteLength === 0) {
    return {};
  }

  const text = rawBody.toString('utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { data: parsed };
  } catch {
    return { rawBody: text };
  }
}

function resolveInboundEventName(
  providerType: InboundProviderType,
  headers: InboundHeadersMap,
  payload: Record<string, unknown>,
): string {
  const customEvent = readHeaderCaseInsensitive(headers, 'x-kestrelmq-event');
  if (customEvent && !/\s/.test(customEvent)) {
    return customEvent;
  }

  if (providerType === InboundProviderType.GITHUB) {
    const githubEvent = readHeaderCaseInsensitive(headers, 'x-github-event');
    if (githubEvent && !/\s/.test(githubEvent)) {
      return `github.${githubEvent}`;
    }
  }

  if (providerType === InboundProviderType.SHOPIFY) {
    const shopifyTopic = readHeaderCaseInsensitive(headers, 'x-shopify-topic');
    if (shopifyTopic && !/\s/.test(shopifyTopic)) {
      return `shopify.${shopifyTopic.replace(/\//g, '.')}`;
    }
  }

  const candidateType =
    typeof payload['type'] === 'string'
      ? payload['type'].trim()
      : typeof payload['event'] === 'string'
        ? payload['event'].trim()
        : undefined;

  if (candidateType && candidateType.length > 0 && !/\s/.test(candidateType)) {
    return candidateType;
  }

  return `inbound.${providerType.toLowerCase()}`;
}

@Injectable()
export class InboundService {
  readonly #prismaService: PrismaService;
  readonly #cryptoService: CryptoService;
  readonly #redisService: RedisService;
  readonly #deliveriesQueue: Queue<DeliveryJobPayload, unknown, string>;

  constructor(
    prismaService: PrismaService,
    cryptoService: CryptoService,
    redisService: RedisService,
    @InjectQueue(DELIVERIES_QUEUE) deliveriesQueue: Queue<DeliveryJobPayload, unknown, string>,
  ) {
    this.#prismaService = prismaService;
    this.#cryptoService = cryptoService;
    this.#redisService = redisService;
    this.#deliveriesQueue = deliveriesQueue;
  }

  async createSource(
    workspaceId: string,
    dto: CreateInboundSourceDto,
  ): Promise<InboundSourceResponse> {
    const trimmedName = dto.name.trim();
    if (trimmedName.length === 0) {
      throw new BadRequestException('Inbound source name must not be empty');
    }

    const trimmedTargetUrl = dto.targetUrl.trim();
    if (!isValidHttpUrl(trimmedTargetUrl)) {
      throw new BadRequestException('targetUrl must be a valid http:// or https:// URL');
    }

    let sourceSlug: string;
    if (dto.sourceSlug !== undefined) {
      sourceSlug = dto.sourceSlug.trim();
      if (sourceSlug.length < 2 || sourceSlug.length > 80 || !SLUG_PATTERN.test(sourceSlug)) {
        throw new BadRequestException(
          'sourceSlug must contain only lowercase alphanumeric characters and single hyphens',
        );
      }
    } else {
      sourceSlug = generateSlugFromName(trimmedName);
    }

    const maxRatePerSec = dto.maxRatePerSec ?? DEFAULT_INBOUND_MAX_RATE_PER_SEC;
    if (!Number.isInteger(maxRatePerSec) || maxRatePerSec < 1 || maxRatePerSec > 10_000) {
      throw new BadRequestException('maxRatePerSec must be an integer between 1 and 10000');
    }

    let encryptedSigningSecret: string | null = null;
    let iv: string | null = null;
    let authTag: string | null = null;

    if (dto.providerType === InboundProviderType.NONE) {
      if (dto.signingSecret !== undefined && dto.signingSecret.trim().length > 0) {
        throw new BadRequestException(
          'signingSecret must not be provided when providerType is NONE',
        );
      }
    } else {
      const secret = dto.signingSecret?.trim();
      if (!secret || secret.length === 0) {
        throw new BadRequestException(
          `signingSecret is required when providerType is ${dto.providerType}`,
        );
      }
      const detached = this.#cryptoService.encryptDetached(secret);
      encryptedSigningSecret = detached.ciphertext;
      iv = detached.iv;
      authTag = detached.authTag;
    }

    try {
      const created = await this.#prismaService.inboundSource.create({
        data: {
          workspaceId,
          name: trimmedName,
          sourceSlug,
          providerType: dto.providerType,
          encryptedSigningSecret,
          iv,
          authTag,
          targetUrl: trimmedTargetUrl,
          maxRatePerSec,
          isPaused: false,
        },
      });

      return this.#toResponse(created);
    } catch (error: unknown) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException(`Inbound source slug "${sourceSlug}" is already in use`);
      }
      throw error;
    }
  }

  async listSources(workspaceId: string): Promise<InboundSourceResponse[]> {
    const records = await this.#prismaService.inboundSource.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });

    return records.map((record) => this.#toResponse(record));
  }

  async deleteSource(workspaceId: string, sourceId: string): Promise<void> {
    const deleted = await this.#prismaService.inboundSource.deleteMany({
      where: {
        id: sourceId,
        workspaceId,
      },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Inbound source not found');
    }
  }

  async pauseSource(workspaceId: string, sourceId: string): Promise<InboundSourceResponse> {
    const existing = await this.#prismaService.inboundSource.findFirst({
      where: {
        id: sourceId,
        workspaceId,
      },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Inbound source not found');
    }

    const updated = await this.#prismaService.$transaction(async (tx) => {
      const source = await tx.inboundSource.update({
        where: { id: existing.id },
        data: { isPaused: true },
      });

      await tx.delivery.updateMany({
        where: {
          workspaceId,
          status: { in: [DeliveryStatus.PENDING, DeliveryStatus.SCHEDULED] },
          event: { inboundSourceId: existing.id },
        },
        data: {
          status: DeliveryStatus.PAUSED,
        },
      });

      return source;
    });

    return this.#toResponse(updated);
  }

  async resumeSource(
    workspaceId: string,
    sourceId: string,
  ): Promise<ResumeInboundSourceResponse> {
    const existing = await this.#prismaService.inboundSource.findFirst({
      where: {
        id: sourceId,
        workspaceId,
      },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Inbound source not found');
    }

    const { updatedSource, drainedDeliveries } = await this.#prismaService.$transaction(
      async (tx) => {
        const source = await tx.inboundSource.update({
          where: { id: existing.id },
          data: { isPaused: false },
        });

        const pausedDeliveries = await tx.delivery.findMany({
          where: {
            workspaceId,
            status: DeliveryStatus.PAUSED,
            event: { inboundSourceId: existing.id },
          },
          select: {
            id: true,
            eventId: true,
            maxAttempts: true,
          },
          orderBy: { createdAt: 'asc' },
        });

        const scheduledItems: {
          readonly id: string;
          readonly eventId: string;
          readonly maxAttempts: number;
          readonly delayMs: number;
        }[] = [];

        for (let index = 0; index < pausedDeliveries.length; index += 1) {
          const item = pausedDeliveries[index]!;
          const delayMs = Math.floor(index / source.maxRatePerSec) * 1_000;
          const nextStatus = delayMs > 0 ? DeliveryStatus.SCHEDULED : DeliveryStatus.PENDING;

          await tx.delivery.update({
            where: { id: item.id },
            data: { status: nextStatus },
          });

          scheduledItems.push({
            id: item.id,
            eventId: item.eventId,
            maxAttempts: item.maxAttempts,
            delayMs,
          });
        }

        return {
          updatedSource: source,
          drainedDeliveries: scheduledItems,
        };
      },
    );

    if (drainedDeliveries.length > 0) {
      const resumeBatchToken = randomUUID();
      await this.#deliveriesQueue.addBulk(
        drainedDeliveries.map((delivery) => ({
          name: DELIVERY_JOB_NAMES.DELIVER_INBOUND,
          data: {
            deliveryId: delivery.id,
            workspaceId,
            eventId: delivery.eventId,
          },
          opts: {
            jobId: `${delivery.id}-resume-${resumeBatchToken}`,
            attempts: delivery.maxAttempts,
            backoff: {
              type: KESTREL_BACKOFF_TYPE,
            },
            ...(delivery.delayMs > 0 ? { delay: delivery.delayMs } : {}),
          },
        })),
      );
    }

    return {
      source: this.#toResponse(updatedSource),
      resumedDeliveriesCount: drainedDeliveries.length,
    };
  }

  async receiveWebhook(
    input: ReceiveInboundWebhookInput,
  ): Promise<ReceiveInboundWebhookResponse> {
    const slug = input.sourceSlug.trim();
    if (slug.length === 0) {
      throw new NotFoundException('Inbound source not found');
    }

    const source = await this.#prismaService.inboundSource.findUnique({
      where: { sourceSlug: slug },
    });

    if (!source) {
      throw new NotFoundException('Inbound source not found');
    }

    const nowMs = input.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1_000);

    if (source.providerType !== InboundProviderType.NONE) {
      if (!Buffer.isBuffer(input.rawBody)) {
        throw new UnauthorizedException(
          'Raw request body is required for webhook signature verification',
        );
      }

      const decryptedSecret = this.#decryptSourceSecret(source);
      const signatureValid = verifyInboundWebhookSignature({
        providerType: source.providerType,
        rawBody: input.rawBody,
        headers: input.headers,
        signingSecret: decryptedSecret,
        nowSec,
      });

      if (!signatureValid) {
        throw new UnauthorizedException('Invalid inbound webhook signature');
      }
    }

    const rateLimitResult = await this.#redisService.checkSlidingWindowRateLimit(
      `ratelimit:inbound:${source.id}`,
      source.maxRatePerSec,
      INBOUND_RATE_WINDOW_MS,
      nowMs,
    );

    if (!rateLimitResult.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(rateLimitResult.retryAfterMs / 1_000));
      throw new InboundRateLimitExceededException(retryAfterSec);
    }

    const effectiveRawBody = Buffer.isBuffer(input.rawBody) ? input.rawBody : Buffer.alloc(0);
    const payload = normalizeInboundPayload(input.parsedBody, effectiveRawBody);
    const eventName = resolveInboundEventName(source.providerType, input.headers, payload);
    const initialStatus = source.isPaused ? DeliveryStatus.PAUSED : DeliveryStatus.PENDING;

    const { createdEvent, createdDelivery } = await this.#prismaService.$transaction(
      async (tx) => {
        const event = await tx.event.create({
          data: {
            workspaceId: source.workspaceId,
            eventName,
            recipient: toPrismaJsonObject({ targetUrl: source.targetUrl }),
            payload: toPrismaJsonObject(payload),
            direction: EventDirection.INBOUND,
            inboundSourceId: source.id,
          },
        });

        const delivery = await tx.delivery.create({
          data: {
            workspaceId: source.workspaceId,
            eventId: event.id,
            routingRuleId: null,
            integrationId: null,
            status: initialStatus,
            maxAttempts: DEFAULT_DELIVERY_MAX_ATTEMPTS,
          },
          select: {
            id: true,
            status: true,
            maxAttempts: true,
          },
        });

        return {
          createdEvent: event,
          createdDelivery: delivery,
        };
      },
    );

    if (!source.isPaused) {
      await this.#deliveriesQueue.add(
        DELIVERY_JOB_NAMES.DELIVER_INBOUND,
        {
          deliveryId: createdDelivery.id,
          workspaceId: source.workspaceId,
          eventId: createdEvent.id,
        },
        {
          jobId: createdDelivery.id,
          attempts: createdDelivery.maxAttempts,
          backoff: {
            type: KESTREL_BACKOFF_TYPE,
          },
        },
      );
    }

    return {
      received: true,
      eventId: createdEvent.id,
      deliveryId: createdDelivery.id,
      status: createdDelivery.status,
      buffered: source.isPaused,
    };
  }

  #decryptSourceSecret(source: StoredInboundSourceRow): string {
    if (!source.encryptedSigningSecret || !source.iv || !source.authTag) {
      throw new UnauthorizedException('Inbound signing secret is not configured');
    }

    return this.#cryptoService.decryptDetached({
      ciphertext: source.encryptedSigningSecret,
      iv: source.iv,
      authTag: source.authTag,
    });
  }

  #toResponse(record: StoredInboundSourceRow): InboundSourceResponse {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      name: record.name,
      sourceSlug: record.sourceSlug,
      providerType: record.providerType,
      hasSigningSecret: record.encryptedSigningSecret !== null,
      targetUrl: record.targetUrl,
      maxRatePerSec: record.maxRatePerSec,
      isPaused: record.isPaused,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
