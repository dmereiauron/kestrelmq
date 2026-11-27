import { DelayedError, type Job, type Queue, UnrecoverableError } from 'bullmq';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type {
  DeliveryJobPayload,
  DlqJobPayload,
} from '../../common/queue/queue.constants.js';
import type { RedisService } from '../../common/redis/redis.service.js';
import { REDACTED_VALUE } from '../../common/utils/mask-sensitive.util.js';
import {
  DeliveryStatus,
  EventDirection,
  IntegrationChannel,
  IntegrationProvider,
} from '../../generated/prisma/enums.js';
import type { IntegrationsService } from '../integrations/integrations.service.js';
import {
  ProviderConfigurationError,
  ProviderDeliveryError,
} from '../providers/errors/provider-delivery.error.js';
import type {
  NotificationProvider,
  ProviderSendResult,
} from '../providers/interfaces/notification-provider.interface.js';
import type { ProviderFactory } from '../providers/provider.factory.js';
import { RulesService } from '../rules/rules.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { DeliveryProcessor } from './delivery.processor.js';

function makeJob(
  data: DeliveryJobPayload,
  options?: {
    attemptsMade?: number;
    maxAttempts?: number;
    moveToDelayed?: ReturnType<typeof vi.fn>;
  },
): Job<DeliveryJobPayload, unknown, string> {
  return {
    id: data.deliveryId,
    name: 'deliver-outbound',
    data,
    attemptsMade: options?.attemptsMade ?? 0,
    opts: {
      attempts: options?.maxAttempts ?? 5,
    },
    moveToDelayed: options?.moveToDelayed ?? vi.fn(),
  } as unknown as Job<DeliveryJobPayload, unknown, string>;
}

describe('DeliveryProcessor (@Processor("deliveries"))', () => {
  let deliveryFindUniqueMock: ReturnType<typeof vi.fn>;
  let deliveryUpdateMock: ReturnType<typeof vi.fn>;
  let attemptCreateMock: ReturnType<typeof vi.fn>;
  let egressRateLimitMock: ReturnType<typeof vi.fn>;
  let decryptCredentialsMock: ReturnType<typeof vi.fn>;
  let providerSendMock: ReturnType<typeof vi.fn>;
  let dlqAddMock: ReturnType<typeof vi.fn>;

  let templatesService: TemplatesService;
  let rulesService: RulesService;
  let processor: DeliveryProcessor;

  beforeEach(() => {
    deliveryFindUniqueMock = vi.fn();
    deliveryUpdateMock = vi.fn().mockResolvedValue({});
    attemptCreateMock = vi.fn().mockResolvedValue({});

    const txClient = {
      deliveryAttempt: { create: attemptCreateMock },
      delivery: { update: deliveryUpdateMock },
    };

    const prismaService = {
      delivery: {
        findUnique: deliveryFindUniqueMock,
        update: deliveryUpdateMock,
      },
      $transaction: vi.fn(async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient)),
    } as unknown as PrismaService;

    egressRateLimitMock = vi.fn().mockResolvedValue({
      allowed: true,
      currentCount: 1,
      retryAfterMs: 0,
    });
    const redisService = {
      checkSlidingWindowRateLimit: egressRateLimitMock,
    } as unknown as RedisService;

    decryptCredentialsMock = vi.fn();
    const integrationsService = {
      decryptIntegrationCredentials: decryptCredentialsMock,
    } as unknown as IntegrationsService;

    templatesService = new TemplatesService({} as unknown as PrismaService);
    rulesService = new RulesService({} as unknown as PrismaService);

    providerSendMock = vi.fn();
    const mockAdapter = {
      provider: IntegrationProvider.MAILGUN,
      channel: IntegrationChannel.EMAIL,
      send: providerSendMock,
      testConnection: vi.fn(),
    } as unknown as NotificationProvider;

    const providerFactory = {
      getProvider: vi.fn().mockReturnValue(mockAdapter),
    } as unknown as ProviderFactory;

    dlqAddMock = vi.fn().mockResolvedValue({});
    const dlqQueue = {
      add: dlqAddMock,
    } as unknown as Queue<DlqJobPayload, unknown, string>;

    processor = new DeliveryProcessor(
      prismaService,
      redisService,
      integrationsService,
      templatesService,
      rulesService,
      providerFactory,
      dlqQueue,
    );
  });

  it('executes outbound delivery, compiles Handlebars template, masks sensitive audit keys, and marks DELIVERED', async () => {
    const workspaceId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const integrationId = randomUUID();
    const signingSecret = randomBytes(24).toString('hex');
    const mailgunKey = randomBytes(16).toString('hex');
    const sensitivePayloadToken = randomBytes(12).toString('hex');

    deliveryFindUniqueMock.mockResolvedValueOnce({
      id: deliveryId,
      workspaceId,
      eventId,
      status: DeliveryStatus.PENDING,
      attemptCount: 0,
      maxAttempts: 5,
      workspace: { webhookSigningSecret: signingSecret },
      event: {
        id: eventId,
        eventName: 'order.paid',
        direction: EventDirection.OUTBOUND,
        recipient: { email: 'customer@kestrelmq.io' },
        payload: {
          orderId: 'ORD-77',
          customerName: 'Grace',
          resetToken: sensitivePayloadToken,
        },
        inboundSource: null,
      },
      routingRule: {
        targetOverride: null,
        template: {
          subjectTemplate: 'Receipt for {{orderId}}',
          bodyTemplate: '<h1>Hello {{customerName}}</h1>',
        },
      },
      integration: {
        id: integrationId,
        channel: IntegrationChannel.EMAIL,
        provider: IntegrationProvider.MAILGUN,
        encryptedCredentials: 'enc',
        iv: 'iv',
        authTag: 'tag',
        isActive: true,
      },
    });

    decryptCredentialsMock.mockReturnValueOnce({
      apiKey: mailgunKey,
      domain: 'mg.kestrelmq.io',
      fromEmail: 'noreply@kestrelmq.io',
    });

    const sendResult: ProviderSendResult = {
      provider: IntegrationProvider.MAILGUN,
      statusCode: 200,
      responseBody: '{"id":"<msg@mg.kestrelmq.io>"}',
      durationMs: 84,
    };
    providerSendMock.mockResolvedValueOnce(sendResult);

    await processor.process(makeJob({ deliveryId, workspaceId, eventId }));

    expect(providerSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'customer@kestrelmq.io',
        content: {
          subject: 'Receipt for ORD-77',
          body: '<h1>Hello Grace</h1>',
          html: '<h1>Hello Grace</h1>',
        },
      }),
    );

    expect(attemptCreateMock).toHaveBeenCalledOnce();
    const attemptData = attemptCreateMock.mock.calls[0]![0] as {
      data: {
        attemptNumber: number;
        responseStatus: number;
        errorMessage: string | null;
        requestPayload: { payload: { resetToken: string } };
      };
    };
    expect(attemptData.data.attemptNumber).toBe(1);
    expect(attemptData.data.responseStatus).toBe(200);
    expect(attemptData.data.errorMessage).toBeNull();
    expect(attemptData.data.requestPayload.payload.resetToken).toBe(REDACTED_VALUE);

    expect(deliveryUpdateMock).toHaveBeenCalledWith({
      where: { id: deliveryId },
      data: expect.objectContaining({
        status: DeliveryStatus.DELIVERED,
        attemptCount: 1,
        nextRetryAt: null,
        deliveredAt: expect.any(Date),
      }),
    });
    expect(dlqAddMock).not.toHaveBeenCalled();
  });

  it('forwards INBOUND webhook deliveries to targetUrl and reschedules via DelayedError when egress rate limit hits', async () => {
    const workspaceId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const sourceId = randomUUID();
    const signingSecret = randomBytes(24).toString('hex');

    const inboundDeliveryRecord = {
      id: deliveryId,
      workspaceId,
      eventId,
      status: DeliveryStatus.PENDING,
      attemptCount: 0,
      maxAttempts: 5,
      workspace: { webhookSigningSecret: signingSecret },
      event: {
        id: eventId,
        eventName: 'github.push',
        direction: EventDirection.INBOUND,
        recipient: { targetUrl: 'http://localhost:4200/hooks/github' },
        payload: { ref: 'refs/heads/main' },
        inboundSource: {
          id: sourceId,
          targetUrl: 'http://localhost:4200/hooks/github',
          maxRatePerSec: 5,
          isPaused: false,
        },
      },
      routingRule: null,
      integration: null,
    };

    // 1. Egress rate-limited -> moves to delayed without recording failed attempt
    deliveryFindUniqueMock.mockResolvedValueOnce(inboundDeliveryRecord);
    egressRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      currentCount: 5,
      retryAfterMs: 350,
    });

    const moveToDelayedSpy = vi.fn().mockResolvedValue(undefined);
    const throttledJob = makeJob(
      { deliveryId, workspaceId, eventId },
      { moveToDelayed: moveToDelayedSpy },
    );

    await expect(processor.process(throttledJob, 'worker-token-1')).rejects.toThrow(DelayedError);
    expect(moveToDelayedSpy).toHaveBeenCalledOnce();
    expect(attemptCreateMock).not.toHaveBeenCalled();

    // 2. Egress allowed -> forwards JSON payload via CUSTOM_WEBHOOK signed with workspace secret
    deliveryFindUniqueMock.mockResolvedValueOnce(inboundDeliveryRecord);
    egressRateLimitMock.mockResolvedValueOnce({
      allowed: true,
      currentCount: 1,
      retryAfterMs: 0,
    });
    providerSendMock.mockResolvedValueOnce({
      provider: IntegrationProvider.CUSTOM_WEBHOOK,
      statusCode: 202,
      responseBody: 'accepted',
      durationMs: 19,
    });

    await processor.process(makeJob({ deliveryId, workspaceId, eventId }));

    expect(providerSendMock).toHaveBeenCalledWith({
      credentials: { url: 'http://localhost:4200/hooks/github' },
      target: 'http://localhost:4200/hooks/github',
      content: { body: '{"ref":"refs/heads/main"}' },
      metadata: {
        eventId,
        eventName: 'github.push',
        deliveryId,
        workspaceSigningSecret: signingSecret,
      },
    });
    expect(deliveryUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: DeliveryStatus.DELIVERED }),
      }),
    );
  });

  it('short-circuits missing, terminal (DELIVERED/CANCELED), and PAUSED deliveries without invoking providers', async () => {
    const payload: DeliveryJobPayload = {
      deliveryId: randomUUID(),
      workspaceId: randomUUID(),
      eventId: randomUUID(),
    };

    deliveryFindUniqueMock.mockResolvedValueOnce(null);
    await processor.process(makeJob(payload));

    deliveryFindUniqueMock.mockResolvedValueOnce({
      id: payload.deliveryId,
      status: DeliveryStatus.DELIVERED,
      event: { direction: EventDirection.OUTBOUND, inboundSource: null },
    });
    await processor.process(makeJob(payload));

    deliveryFindUniqueMock.mockResolvedValueOnce({
      id: payload.deliveryId,
      status: DeliveryStatus.PENDING,
      event: {
        direction: EventDirection.INBOUND,
        inboundSource: { id: randomUUID(), isPaused: true },
      },
    });
    await processor.process(makeJob(payload));

    expect(deliveryUpdateMock).toHaveBeenCalledWith({
      where: { id: payload.deliveryId },
      data: { status: DeliveryStatus.PAUSED },
    });
    expect(providerSendMock).not.toHaveBeenCalled();
  });

  it('marks RETRYING + nextRetryAt on transient 429/5xx errors and marks FAILED + DLQ when maxAttempts exhausted', async () => {
    const workspaceId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const signingSecret = randomBytes(24).toString('hex');

    const baseDelivery = {
      id: deliveryId,
      workspaceId,
      eventId,
      status: DeliveryStatus.PENDING,
      attemptCount: 0,
      maxAttempts: 5,
      workspace: { webhookSigningSecret: signingSecret },
      event: {
        id: eventId,
        eventName: 'order.paid',
        direction: EventDirection.OUTBOUND,
        recipient: {},
        payload: { orderId: 'ORD-500' },
        inboundSource: null,
      },
      routingRule: null,
      integration: {
        id: randomUUID(),
        channel: IntegrationChannel.WEBHOOK,
        provider: IntegrationProvider.CUSTOM_WEBHOOK,
        encryptedCredentials: 'enc',
        iv: 'iv',
        authTag: 'tag',
        isActive: true,
      },
    };

    decryptCredentialsMock.mockReturnValue({ url: 'https://hooks.client.io/orders' });

    const transient503 = new ProviderDeliveryError({
      provider: IntegrationProvider.CUSTOM_WEBHOOK,
      message: 'Webhook endpoint responded with HTTP 503',
      retryable: true,
      statusCode: 503,
      responseBody: 'Service Unavailable',
      durationMs: 120,
    });

    // Attempt 1 of 5 -> RETRYING + rethrows ProviderDeliveryError (NOT UnrecoverableError)
    deliveryFindUniqueMock.mockResolvedValueOnce(baseDelivery);
    providerSendMock.mockRejectedValueOnce(transient503);

    let thrownAttempt1: unknown;
    try {
      await processor.process(makeJob({ deliveryId, workspaceId, eventId }, { attemptsMade: 0 }));
    } catch (err: unknown) {
      thrownAttempt1 = err;
    }

    expect(thrownAttempt1).toBe(transient503);
    expect(thrownAttempt1).not.toBeInstanceOf(UnrecoverableError);
    expect(deliveryUpdateMock).toHaveBeenCalledWith({
      where: { id: deliveryId },
      data: expect.objectContaining({
        status: DeliveryStatus.RETRYING,
        attemptCount: 1,
        nextRetryAt: expect.any(Date),
      }),
    });
    expect(dlqAddMock).not.toHaveBeenCalled();

    // Attempt 5 of 5 (exhausted) -> FAILED + nextRetryAt: null + enqueued to DLQ
    deliveryFindUniqueMock.mockResolvedValueOnce({
      ...baseDelivery,
      status: DeliveryStatus.RETRYING,
      attemptCount: 4,
    });
    providerSendMock.mockRejectedValueOnce(transient503);

    await expect(
      processor.process(makeJob({ deliveryId, workspaceId, eventId }, { attemptsMade: 4 })),
    ).rejects.toThrow('Webhook endpoint responded with HTTP 503');

    expect(deliveryUpdateMock).toHaveBeenLastCalledWith({
      where: { id: deliveryId },
      data: {
        status: DeliveryStatus.FAILED,
        attemptCount: 5,
        nextRetryAt: null,
      },
    });
    expect(dlqAddMock).toHaveBeenCalledOnce();
  });

  it('immediately fails with UnrecoverableError on fatal 4xx, BYOT TemplateResolutionError, or ProviderConfigurationError', async () => {
    const workspaceId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const signingSecret = randomBytes(24).toString('hex');

    // 1. Fatal HTTP 400 from provider -> UnrecoverableError + FAILED on attempt 1
    deliveryFindUniqueMock.mockResolvedValueOnce({
      id: deliveryId,
      workspaceId,
      eventId,
      status: DeliveryStatus.PENDING,
      attemptCount: 0,
      maxAttempts: 5,
      workspace: { webhookSigningSecret: signingSecret },
      event: {
        id: eventId,
        eventName: 'order.paid',
        direction: EventDirection.OUTBOUND,
        recipient: {},
        payload: { orderId: 'ORD-400' },
        inboundSource: null,
      },
      routingRule: null,
      integration: {
        id: randomUUID(),
        channel: IntegrationChannel.WEBHOOK,
        provider: IntegrationProvider.CUSTOM_WEBHOOK,
        encryptedCredentials: 'enc',
        iv: 'iv',
        authTag: 'tag',
        isActive: true,
      },
    });

    decryptCredentialsMock.mockReturnValueOnce({ url: 'https://hooks.client.io/orders' });
    providerSendMock.mockRejectedValueOnce(
      new ProviderDeliveryError({
        provider: IntegrationProvider.CUSTOM_WEBHOOK,
        message: 'Webhook endpoint responded with HTTP 400',
        retryable: false,
        statusCode: 400,
        responseBody: 'Bad Payload',
        durationMs: 32,
      }),
    );

    await expect(
      processor.process(makeJob({ deliveryId, workspaceId, eventId })),
    ).rejects.toThrow(UnrecoverableError);

    expect(deliveryUpdateMock).toHaveBeenLastCalledWith({
      where: { id: deliveryId },
      data: {
        status: DeliveryStatus.FAILED,
        attemptCount: 1,
        nextRetryAt: null,
      },
    });
    expect(dlqAddMock).toHaveBeenCalledTimes(1);

    // 2. BYOT Email missing subject/html -> TemplateResolutionError -> UnrecoverableError
    deliveryFindUniqueMock.mockResolvedValueOnce({
      id: deliveryId,
      workspaceId,
      eventId,
      status: DeliveryStatus.PENDING,
      attemptCount: 0,
      maxAttempts: 5,
      workspace: { webhookSigningSecret: signingSecret },
      event: {
        id: eventId,
        eventName: 'user.welcome',
        direction: EventDirection.OUTBOUND,
        recipient: { email: 'user@kestrelmq.io' },
        payload: { name: 'No Subject Or Html' },
        inboundSource: null,
      },
      routingRule: {
        targetOverride: null,
        template: null,
      },
      integration: {
        id: randomUUID(),
        channel: IntegrationChannel.EMAIL,
        provider: IntegrationProvider.MAILGUN,
        encryptedCredentials: 'enc',
        iv: 'iv',
        authTag: 'tag',
        isActive: true,
      },
    });

    decryptCredentialsMock.mockReturnValueOnce({
      apiKey: randomBytes(16).toString('hex'),
      domain: 'mg.kestrelmq.io',
      fromEmail: 'noreply@kestrelmq.io',
    });

    await expect(
      processor.process(makeJob({ deliveryId, workspaceId, eventId })),
    ).rejects.toThrow(UnrecoverableError);

    // 3. Inactive integration -> ProviderConfigurationError -> UnrecoverableError
    deliveryFindUniqueMock.mockResolvedValueOnce({
      id: deliveryId,
      workspaceId,
      eventId,
      status: DeliveryStatus.PENDING,
      attemptCount: 0,
      maxAttempts: 5,
      workspace: { webhookSigningSecret: signingSecret },
      event: {
        id: eventId,
        eventName: 'user.welcome',
        direction: EventDirection.OUTBOUND,
        recipient: {},
        payload: {},
        inboundSource: null,
      },
      routingRule: null,
      integration: {
        id: randomUUID(),
        channel: IntegrationChannel.WEBHOOK,
        provider: IntegrationProvider.CUSTOM_WEBHOOK,
        encryptedCredentials: 'enc',
        iv: 'iv',
        authTag: 'tag',
        isActive: false,
      },
    });

    await expect(
      processor.process(makeJob({ deliveryId, workspaceId, eventId })),
    ).rejects.toThrow(UnrecoverableError);
    expect(dlqAddMock).toHaveBeenCalledTimes(3);

    // 4. Explicit ProviderConfigurationError from decrypt
    deliveryFindUniqueMock.mockResolvedValueOnce({
      id: deliveryId,
      workspaceId,
      eventId,
      status: DeliveryStatus.PENDING,
      attemptCount: 0,
      maxAttempts: 5,
      workspace: { webhookSigningSecret: signingSecret },
      event: {
        id: eventId,
        eventName: 'user.welcome',
        direction: EventDirection.OUTBOUND,
        recipient: {},
        payload: {},
        inboundSource: null,
      },
      routingRule: null,
      integration: {
        id: randomUUID(),
        channel: IntegrationChannel.WEBHOOK,
        provider: IntegrationProvider.CUSTOM_WEBHOOK,
        encryptedCredentials: 'enc',
        iv: 'iv',
        authTag: 'tag',
        isActive: true,
      },
    });
    decryptCredentialsMock.mockImplementationOnce(() => {
      throw new ProviderConfigurationError(
        IntegrationProvider.CUSTOM_WEBHOOK,
        'Malformed webhook credentials',
      );
    });

    await expect(
      processor.process(makeJob({ deliveryId, workspaceId, eventId })),
    ).rejects.toThrow(UnrecoverableError);
  });
});
