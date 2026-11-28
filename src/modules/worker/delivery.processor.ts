import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, type Job, type Queue, UnrecoverableError } from 'bullmq';
import { performance } from 'node:perf_hooks';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  DELIVERIES_DLQ_QUEUE,
  DELIVERIES_QUEUE,
  type DeliveryJobPayload,
  DLQ_JOB_NAMES,
  type DlqJobPayload,
} from '../../common/queue/queue.constants.js';
import { RedisService } from '../../common/redis/redis.service.js';
import {
  maskSensitiveData,
  maskSensitiveJsonString,
} from '../../common/utils/mask-sensitive.util.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  DeliveryStatus,
  EventDirection,
  IntegrationProvider,
} from '../../generated/prisma/enums.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import {
  ProviderConfigurationError,
  ProviderDeliveryError,
} from '../providers/errors/provider-delivery.error.js';
import { ProviderFactory } from '../providers/provider.factory.js';
import type { ProviderCredentials } from '../providers/schemas/provider-credentials.schema.js';
import { RulesService } from '../rules/rules.service.js';
import { TemplateResolutionError, TemplatesService } from '../templates/templates.service.js';
import { computeBackoffDelayMs, kestrelBackoffStrategy } from './utils/backoff.util.js';

const MAX_STORED_RESPONSE_BODY_CHARS = 16_384;
const INBOUND_EGRESS_WINDOW_MS = 1_000;

interface ClassifiedDeliveryError {
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly responseBody: string | null;
  readonly durationMs: number;
  readonly message: string;
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asOptionalPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function toSafePrismaJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  const masked = maskSensitiveData(value);
  return JSON.parse(JSON.stringify(masked)) as Prisma.InputJsonObject;
}

function truncateOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value.length <= MAX_STORED_RESPONSE_BODY_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_STORED_RESPONSE_BODY_CHARS)}...[truncated]`;
}

function sanitizeResponseBody(value: string | null | undefined): string | null {
  const masked = maskSensitiveJsonString(value, { maskPii: true });
  return truncateOptionalText(masked);
}

function classifyDeliveryError(
  error: unknown,
  fallbackDurationMs: number,
): ClassifiedDeliveryError {
  if (error instanceof ProviderDeliveryError) {
    return {
      retryable: error.retryable,
      statusCode: error.statusCode,
      responseBody: error.responseBody,
      durationMs: error.durationMs,
      message: error.message,
    };
  }

  if (
    error instanceof ProviderConfigurationError ||
    error instanceof TemplateResolutionError ||
    error instanceof UnrecoverableError
  ) {
    return {
      retryable: false,
      statusCode: null,
      responseBody: null,
      durationMs: fallbackDurationMs,
      message: error.message,
    };
  }

  const rawMessage =
    error instanceof Error ? error.message : 'Unexpected transient delivery worker failure';

  return {
    retryable: true,
    statusCode: null,
    responseBody: null,
    durationMs: fallbackDurationMs,
    message: rawMessage,
  };
}

@Processor(DELIVERIES_QUEUE, {
  concurrency: 10,
  settings: {
    backoffStrategy: kestrelBackoffStrategy,
  },
})
export class DeliveryProcessor extends WorkerHost {
  readonly #logger = new Logger(DeliveryProcessor.name);
  readonly #prismaService: PrismaService;
  readonly #redisService: RedisService;
  readonly #integrationsService: IntegrationsService;
  readonly #templatesService: TemplatesService;
  readonly #rulesService: RulesService;
  readonly #providerFactory: ProviderFactory;
  readonly #dlqQueue: Queue<DlqJobPayload, unknown, string>;

  constructor(
    prismaService: PrismaService,
    redisService: RedisService,
    integrationsService: IntegrationsService,
    templatesService: TemplatesService,
    rulesService: RulesService,
    providerFactory: ProviderFactory,
    @InjectQueue(DELIVERIES_DLQ_QUEUE) dlqQueue: Queue<DlqJobPayload, unknown, string>,
  ) {
    super();
    this.#prismaService = prismaService;
    this.#redisService = redisService;
    this.#integrationsService = integrationsService;
    this.#templatesService = templatesService;
    this.#rulesService = rulesService;
    this.#providerFactory = providerFactory;
    this.#dlqQueue = dlqQueue;
  }

  override async process(
    job: Job<DeliveryJobPayload, unknown, string>,
    token?: string,
  ): Promise<void> {
    const delivery = await this.#prismaService.delivery.findUnique({
      where: { id: job.data.deliveryId },
      include: {
        workspace: {
          select: {
            webhookSigningSecret: true,
          },
        },
        event: {
          include: {
            inboundSource: true,
          },
        },
        routingRule: {
          include: {
            template: true,
          },
        },
        integration: true,
      },
    });

    if (!delivery) {
      this.#logger.warn(`Skipping missing delivery record: ${job.data.deliveryId}`);
      return;
    }

    if (
      delivery.status === DeliveryStatus.DELIVERED ||
      delivery.status === DeliveryStatus.CANCELED
    ) {
      return;
    }

    const isInboundPaused =
      delivery.event.direction === EventDirection.INBOUND &&
      delivery.event.inboundSource?.isPaused === true;

    if (delivery.status === DeliveryStatus.PAUSED || isInboundPaused) {
      if (delivery.status !== DeliveryStatus.PAUSED) {
        await this.#prismaService.delivery.update({
          where: { id: delivery.id },
          data: { status: DeliveryStatus.PAUSED },
        });
      }
      return;
    }

    if (
      delivery.event.direction === EventDirection.INBOUND &&
      delivery.event.inboundSource !== null
    ) {
      const egressRate = await this.#redisService.checkSlidingWindowRateLimit(
        `ratelimit:inbound:egress:${delivery.event.inboundSource.id}`,
        delivery.event.inboundSource.maxRatePerSec,
        INBOUND_EGRESS_WINDOW_MS,
      );

      if (!egressRate.allowed && token !== undefined && typeof job.moveToDelayed === 'function') {
        await job.moveToDelayed(Date.now() + egressRate.retryAfterMs, token);
        throw new DelayedError();
      }
    }

    const attemptNumber = Math.max(delivery.attemptCount + 1, job.attemptsMade + 1);
    const maxAllowedAttempts = job.opts.attempts ?? delivery.maxAttempts;
    const payloadObj = asPlainObject(delivery.event.payload);
    const recipientObj = asOptionalPlainObject(delivery.event.recipient);

    const requestSnapshot: Record<string, unknown> = {
      eventId: delivery.event.id,
      eventName: delivery.event.eventName,
      direction: delivery.event.direction,
      payload: payloadObj,
    };

    const startedAt = performance.now();

    try {
      const sendResult =
        delivery.event.direction === EventDirection.INBOUND
          ? await this.#executeInboundForwarding(delivery, payloadObj, requestSnapshot)
          : await this.#executeOutboundDelivery(
              delivery,
              payloadObj,
              recipientObj,
              requestSnapshot,
            );

      const safeRequestPayload = toSafePrismaJsonObject(requestSnapshot);

      await this.#prismaService.$transaction(async (tx) => {
        await tx.deliveryAttempt.create({
          data: {
            deliveryId: delivery.id,
            attemptNumber,
            requestPayload: safeRequestPayload,
            responseStatus: sendResult.statusCode,
            responseBody: sanitizeResponseBody(sendResult.responseBody),
            errorMessage: null,
            durationMs: sendResult.durationMs,
          },
        });

        await tx.delivery.update({
          where: { id: delivery.id },
          data: {
            status: DeliveryStatus.DELIVERED,
            attemptCount: attemptNumber,
            deliveredAt: new Date(),
            nextRetryAt: null,
          },
        });
      });
    } catch (error: unknown) {
      if (error instanceof DelayedError) {
        throw error;
      }

      const fallbackDurationMs = Math.max(0, Math.round(performance.now() - startedAt));
      const classified = classifyDeliveryError(error, fallbackDurationMs);
      const safeRequestPayload = toSafePrismaJsonObject(requestSnapshot);

      if (!classified.retryable) {
        await this.#recordFailedAttempt({
          deliveryId: delivery.id,
          attemptNumber,
          requestPayload: safeRequestPayload,
          status: DeliveryStatus.FAILED,
          nextRetryAt: null,
          classified,
        });

        await this.#enqueueDlqSafely({
          deliveryId: delivery.id,
          workspaceId: delivery.workspaceId,
          eventId: delivery.eventId,
          errorMessage: classified.message,
          statusCode: classified.statusCode,
          attemptsMade: attemptNumber,
          failedAt: new Date().toISOString(),
        });

        throw new UnrecoverableError(classified.message);
      }

      const hasRemainingRetries = attemptNumber < maxAllowedAttempts;

      if (hasRemainingRetries) {
        const nextDelayMs = computeBackoffDelayMs(attemptNumber);
        const nextRetryAt = new Date(Date.now() + nextDelayMs);

        await this.#recordFailedAttempt({
          deliveryId: delivery.id,
          attemptNumber,
          requestPayload: safeRequestPayload,
          status: DeliveryStatus.RETRYING,
          nextRetryAt,
          classified,
        });

        throw error instanceof Error ? error : new Error(classified.message);
      }

      await this.#recordFailedAttempt({
        deliveryId: delivery.id,
        attemptNumber,
        requestPayload: safeRequestPayload,
        status: DeliveryStatus.FAILED,
        nextRetryAt: null,
        classified,
      });

      await this.#enqueueDlqSafely({
        deliveryId: delivery.id,
        workspaceId: delivery.workspaceId,
        eventId: delivery.eventId,
        errorMessage: classified.message,
        statusCode: classified.statusCode,
        attemptsMade: attemptNumber,
        failedAt: new Date().toISOString(),
      });

      throw error instanceof Error ? error : new Error(classified.message);
    }
  }

  async #executeOutboundDelivery(
    delivery: {
      readonly id: string;
      readonly workspace: { readonly webhookSigningSecret: string };
      readonly event: { readonly id: string; readonly eventName: string };
      readonly routingRule: {
        readonly targetOverride: string | null;
        readonly template: {
          readonly subjectTemplate: string | null;
          readonly bodyTemplate: string;
        } | null;
      } | null;
      readonly integration: {
        readonly id: string;
        readonly channel: import('../../generated/prisma/enums.js').IntegrationChannel;
        readonly provider: IntegrationProvider;
        readonly encryptedCredentials: string;
        readonly iv: string;
        readonly authTag: string;
        readonly isActive: boolean;
      } | null;
    },
    payloadObj: Record<string, unknown>,
    recipientObj: Record<string, unknown> | undefined,
    requestSnapshot: Record<string, unknown>,
  ) {
    const integration = delivery.integration;
    if (!integration || !integration.isActive) {
      throw new ProviderConfigurationError(
        integration?.provider ?? IntegrationProvider.CUSTOM_WEBHOOK,
        'Target integration is missing or inactive',
      );
    }

    let credentials: ProviderCredentials;
    try {
      credentials = this.#integrationsService.decryptIntegrationCredentials(integration);
    } catch (error: unknown) {
      if (error instanceof ProviderConfigurationError) {
        throw error;
      }
      throw new ProviderConfigurationError(
        integration.provider,
        'Failed to decrypt or validate integration credentials',
      );
    }

    const content = this.#templatesService.resolveContent({
      channel: integration.channel,
      template: delivery.routingRule?.template ?? null,
      payload: payloadObj,
    });

    const target = this.#rulesService.resolveRecipientTarget({
      channel: integration.channel,
      targetOverride: delivery.routingRule?.targetOverride ?? null,
      recipient: recipientObj,
      payload: payloadObj,
    });

    requestSnapshot['channel'] = integration.channel;
    requestSnapshot['provider'] = integration.provider;
    requestSnapshot['target'] = target ?? null;
    requestSnapshot['subject'] = content.subject ?? null;

    const adapter = this.#providerFactory.getProvider(integration.provider);
    return adapter.send({
      credentials,
      target,
      content,
      metadata: {
        eventId: delivery.event.id,
        eventName: delivery.event.eventName,
        deliveryId: delivery.id,
        workspaceSigningSecret: delivery.workspace.webhookSigningSecret,
      },
    });
  }

  async #executeInboundForwarding(
    delivery: {
      readonly id: string;
      readonly workspace: { readonly webhookSigningSecret: string };
      readonly event: {
        readonly id: string;
        readonly eventName: string;
        readonly inboundSource: {
          readonly id: string;
          readonly targetUrl: string;
        } | null;
      };
    },
    payloadObj: Record<string, unknown>,
    requestSnapshot: Record<string, unknown>,
  ) {
    const inboundSource = delivery.event.inboundSource;
    if (!inboundSource) {
      throw new ProviderConfigurationError(
        IntegrationProvider.CUSTOM_WEBHOOK,
        'Inbound source configuration is missing for inbound delivery',
      );
    }

    requestSnapshot['provider'] = IntegrationProvider.CUSTOM_WEBHOOK;
    requestSnapshot['targetUrl'] = inboundSource.targetUrl;

    const adapter = this.#providerFactory.getProvider(IntegrationProvider.CUSTOM_WEBHOOK);
    return adapter.send({
      credentials: { url: inboundSource.targetUrl },
      target: inboundSource.targetUrl,
      content: {
        body: JSON.stringify(payloadObj),
      },
      metadata: {
        eventId: delivery.event.id,
        eventName: delivery.event.eventName,
        deliveryId: delivery.id,
        workspaceSigningSecret: delivery.workspace.webhookSigningSecret,
      },
    });
  }

  async #recordFailedAttempt(params: {
    readonly deliveryId: string;
    readonly attemptNumber: number;
    readonly requestPayload: Prisma.InputJsonObject;
    readonly status: DeliveryStatus;
    readonly nextRetryAt: Date | null;
    readonly classified: ClassifiedDeliveryError;
  }): Promise<void> {
    await this.#prismaService.$transaction(async (tx) => {
      await tx.deliveryAttempt.create({
        data: {
          deliveryId: params.deliveryId,
          attemptNumber: params.attemptNumber,
          requestPayload: params.requestPayload,
          responseStatus: params.classified.statusCode,
          responseBody: sanitizeResponseBody(params.classified.responseBody),
          errorMessage: truncateOptionalText(params.classified.message),
          durationMs: params.classified.durationMs,
        },
      });

      await tx.delivery.update({
        where: { id: params.deliveryId },
        data: {
          status: params.status,
          attemptCount: params.attemptNumber,
          nextRetryAt: params.nextRetryAt,
        },
      });
    });
  }

  async #enqueueDlqSafely(payload: DlqJobPayload): Promise<void> {
    try {
      await this.#dlqQueue.add(DLQ_JOB_NAMES.DEAD_LETTER_DELIVERY, payload, {
        jobId: `dlq:${payload.deliveryId}:${payload.attemptsMade}`,
      });
    } catch (dlqError: unknown) {
      this.#logger.error(
        JSON.stringify({
          message: 'Failed to enqueue dead-letter delivery record',
          deliveryId: payload.deliveryId,
          error: maskSensitiveData(dlqError, { maskPii: true }),
        }),
      );
    }
  }
}
