import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { ROLES_KEY } from '../../common/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  DELIVERY_JOB_NAMES,
  type DeliveryJobPayload,
  KESTREL_BACKOFF_TYPE,
} from '../../common/queue/queue.constants.js';
import type { EnvConfig } from '../../config/env.validation.js';
import {
  DeliveryStatus,
  EventDirection,
  InboundProviderType,
  WorkspaceRole,
} from '../../generated/prisma/enums.js';
import { CreateInboundSourceDto } from './dto/create-inbound-source.dto.js';
import { InboundGatewayController } from './inbound-gateway.controller.js';
import { InboundSourcesController } from './inbound-sources.controller.js';
import { InboundService } from './inbound.service.js';

describe('InboundService, InboundSourcesController & InboundGatewayController', () => {
  let cryptoService: CryptoService;
  let sourceCreateMock: ReturnType<typeof vi.fn>;
  let sourceFindManyMock: ReturnType<typeof vi.fn>;
  let sourceFindFirstMock: ReturnType<typeof vi.fn>;
  let sourceFindUniqueMock: ReturnType<typeof vi.fn>;
  let sourceUpdateMock: ReturnType<typeof vi.fn>;
  let sourceDeleteManyMock: ReturnType<typeof vi.fn>;
  let eventCreateMock: ReturnType<typeof vi.fn>;
  let deliveryCreateMock: ReturnType<typeof vi.fn>;
  let deliveryFindManyMock: ReturnType<typeof vi.fn>;
  let deliveryUpdateMock: ReturnType<typeof vi.fn>;
  let deliveryUpdateManyMock: ReturnType<typeof vi.fn>;
  let queueAddMock: ReturnType<typeof vi.fn>;
  let queueAddBulkMock: ReturnType<typeof vi.fn>;

  let service: InboundService;
  let sourcesController: InboundSourcesController;
  let gatewayController: InboundGatewayController;

  beforeEach(() => {
    const masterKeyHex = randomBytes(32).toString('hex');
    const configService = {
      get: vi.fn().mockReturnValue(masterKeyHex),
    } as unknown as ConfigService<EnvConfig, true>;
    cryptoService = new CryptoService(configService);

    sourceCreateMock = vi.fn();
    sourceFindManyMock = vi.fn();
    sourceFindFirstMock = vi.fn();
    sourceFindUniqueMock = vi.fn();
    sourceUpdateMock = vi.fn();
    sourceDeleteManyMock = vi.fn();
    eventCreateMock = vi.fn();
    deliveryCreateMock = vi.fn();
    deliveryFindManyMock = vi.fn();
    deliveryUpdateMock = vi.fn();
    deliveryUpdateManyMock = vi.fn();

    const txClient = {
      inboundSource: {
        update: sourceUpdateMock,
      },
      event: {
        create: eventCreateMock,
      },
      delivery: {
        create: deliveryCreateMock,
        findMany: deliveryFindManyMock,
        update: deliveryUpdateMock,
        updateMany: deliveryUpdateManyMock,
      },
    };

    const prismaService = {
      $transaction: vi.fn(async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient)),
      inboundSource: {
        create: sourceCreateMock,
        findMany: sourceFindManyMock,
        findFirst: sourceFindFirstMock,
        findUnique: sourceFindUniqueMock,
        deleteMany: sourceDeleteManyMock,
      },
    } as unknown as PrismaService;

    queueAddMock = vi.fn().mockResolvedValue({});
    queueAddBulkMock = vi.fn().mockResolvedValue([]);
    const deliveriesQueue = {
      add: queueAddMock,
      addBulk: queueAddBulkMock,
    } as unknown as Queue<DeliveryJobPayload, unknown, string>;

    service = new InboundService(prismaService, cryptoService, deliveriesQueue);
    sourcesController = new InboundSourcesController(service);
    gatewayController = new InboundGatewayController(service);
  });

  it('manages InboundSource CRUD, encrypts signingSecret via CryptoService.encryptDetached, and omits secrets in responses', async () => {
    const workspaceId = randomUUID();
    const sourceId = randomUUID();
    const rawSecret = randomBytes(24).toString('base64url');
    const now = new Date();

    // Missing signingSecret on non-NONE provider fails
    await expect(
      sourcesController.createSource(workspaceId, {
        name: 'Stripe Prod',
        providerType: InboundProviderType.STRIPE,
        targetUrl: 'https://api.customer.io/webhooks/stripe',
      }),
    ).rejects.toThrow(BadRequestException);

    // Providing signingSecret when providerType is NONE fails
    await expect(
      sourcesController.createSource(workspaceId, {
        name: 'Open Hook',
        providerType: InboundProviderType.NONE,
        signingSecret: rawSecret,
        targetUrl: 'https://api.customer.io/webhooks/open',
      }),
    ).rejects.toThrow(BadRequestException);

    sourceCreateMock.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: sourceId,
      ...data,
      createdAt: now,
      updatedAt: now,
    }));

    const created = await sourcesController.createSource(workspaceId, {
      name: 'Stripe Billing',
      sourceSlug: 'stripe-billing-prod',
      providerType: InboundProviderType.STRIPE,
      signingSecret: rawSecret,
      targetUrl: 'https://api.customer.io/webhooks/stripe',
      maxRatePerSec: 15,
    });

    expect(created.id).toBe(sourceId);
    expect(created.sourceSlug).toBe('stripe-billing-prod');
    expect(created.hasSigningSecret).toBe(true);
    expect('encryptedSigningSecret' in created).toBe(false);
    expect('iv' in created).toBe(false);
    expect('authTag' in created).toBe(false);

    // Verify encrypted detached payload round-trips cleanly
    const persistedArgs = sourceCreateMock.mock.calls[0]![0] as {
      data: { encryptedSigningSecret: string; iv: string; authTag: string };
    };
    expect(
      cryptoService.decryptDetached({
        ciphertext: persistedArgs.data.encryptedSigningSecret,
        iv: persistedArgs.data.iv,
        authTag: persistedArgs.data.authTag,
      }),
    ).toBe(rawSecret);

    // Duplicate slug P2002 maps to 409 Conflict
    sourceCreateMock.mockRejectedValueOnce(Object.assign(new Error('Duplicate'), { code: 'P2002' }));
    await expect(
      sourcesController.createSource(workspaceId, {
        name: 'Duplicate',
        sourceSlug: 'stripe-billing-prod',
        providerType: InboundProviderType.NONE,
        targetUrl: 'https://api.customer.io/webhooks/open',
      }),
    ).rejects.toThrow(ConflictException);

    // List & Delete
    sourceFindManyMock.mockResolvedValueOnce([
      {
        id: sourceId,
        workspaceId,
        name: 'Stripe Billing',
        sourceSlug: 'stripe-billing-prod',
        providerType: InboundProviderType.STRIPE,
        encryptedSigningSecret: persistedArgs.data.encryptedSigningSecret,
        iv: persistedArgs.data.iv,
        authTag: persistedArgs.data.authTag,
        targetUrl: 'https://api.customer.io/webhooks/stripe',
        maxRatePerSec: 15,
        isPaused: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const list = await sourcesController.listSources(workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0]?.hasSigningSecret).toBe(true);

    // Verify VIEWER role is permitted on GET /v1/inbound-sources
    const reflector = new Reflector();
    const listRoles = reflector.getAllAndOverride<readonly WorkspaceRole[]>(ROLES_KEY, [
      InboundSourcesController.prototype.listSources,
      InboundSourcesController,
    ]);
    expect(listRoles).toEqual([
      WorkspaceRole.OWNER,
      WorkspaceRole.ADMIN,
      WorkspaceRole.VIEWER,
    ]);

    sourceDeleteManyMock.mockResolvedValueOnce({ count: 1 });
    await expect(sourcesController.deleteSource(workspaceId, sourceId)).resolves.toBeUndefined();

    sourceDeleteManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(sourcesController.deleteSource(workspaceId, randomUUID())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('verifies all 5 provider signatures on POST /v1/inbound/:sourceSlug, rejects 401/404, and absorbs traffic spikes without 429 drops', async () => {
    const workspaceId = randomUUID();
    const fixedNowMs = 1_760_000_000_000;
    const fixedNowSec = Math.floor(fixedNowMs / 1_000);
    const rawJson = '{"id":"evt_live_1","type":"invoice.paid"}';
    const rawBody = Buffer.from(rawJson, 'utf8');
    const secret = randomBytes(24).toString('hex');
    const detached = cryptoService.encryptDetached(secret);

    const makeSource = (providerType: InboundProviderType) => ({
      id: randomUUID(),
      workspaceId,
      name: `Src ${providerType}`,
      sourceSlug: `slug-${providerType.toLowerCase()}`,
      providerType,
      encryptedSigningSecret:
        providerType === InboundProviderType.NONE ? null : detached.ciphertext,
      iv: providerType === InboundProviderType.NONE ? null : detached.iv,
      authTag: providerType === InboundProviderType.NONE ? null : detached.authTag,
      targetUrl: 'http://localhost:4100/ingest',
      maxRatePerSec: 5,
      isPaused: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const mockPersistSuccess = () => {
      const eventId = randomUUID();
      const deliveryId = randomUUID();
      eventCreateMock.mockResolvedValueOnce({
        id: eventId,
        direction: EventDirection.INBOUND,
      });
      deliveryCreateMock.mockResolvedValueOnce({
        id: deliveryId,
        status: DeliveryStatus.PENDING,
        maxAttempts: 5,
      });
      return { eventId, deliveryId };
    };

    // 1. STRIPE valid
    const stripeSrc = makeSource(InboundProviderType.STRIPE);
    const stripeSig = createHmac('sha256', secret)
      .update(`${fixedNowSec}.`, 'utf8')
      .update(rawBody)
      .digest('hex');
    sourceFindUniqueMock.mockResolvedValueOnce(stripeSrc);
    mockPersistSuccess();
    const stripeRes = await service.receiveWebhook({
      sourceSlug: stripeSrc.sourceSlug,
      rawBody,
      headers: { 'stripe-signature': `t=${fixedNowSec},v1=${stripeSig}` },
      nowMs: fixedNowMs,
    });
    expect(stripeRes.received).toBe(true);
    expect(stripeRes.status).toBe(DeliveryStatus.PENDING);

    // 2. GITHUB valid
    const githubSrc = makeSource(InboundProviderType.GITHUB);
    const githubSig = createHmac('sha256', secret).update(rawBody).digest('hex');
    sourceFindUniqueMock.mockResolvedValueOnce(githubSrc);
    mockPersistSuccess();
    const githubRes = await service.receiveWebhook({
      sourceSlug: githubSrc.sourceSlug,
      rawBody,
      headers: {
        'x-hub-signature-256': `sha256=${githubSig}`,
        'x-github-event': 'push',
      },
      nowMs: fixedNowMs,
    });
    expect(githubRes.received).toBe(true);
    expect(eventCreateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'github.push',
          direction: EventDirection.INBOUND,
        }),
      }),
    );

    // 3. SHOPIFY valid
    const shopifySrc = makeSource(InboundProviderType.SHOPIFY);
    const shopifySig = createHmac('sha256', secret).update(rawBody).digest('base64');
    sourceFindUniqueMock.mockResolvedValueOnce(shopifySrc);
    mockPersistSuccess();
    await expect(
      service.receiveWebhook({
        sourceSlug: shopifySrc.sourceSlug,
        rawBody,
        headers: {
          'x-shopify-hmac-sha256': shopifySig,
          'x-shopify-topic': 'orders/create',
        },
        nowMs: fixedNowMs,
      }),
    ).resolves.toMatchObject({ received: true });

    // 4. CUSTOM_HMAC valid
    const customSrc = makeSource(InboundProviderType.CUSTOM_HMAC);
    const customSig = cryptoService.signWebhookPayload(rawBody, secret, fixedNowSec);
    sourceFindUniqueMock.mockResolvedValueOnce(customSrc);
    mockPersistSuccess();
    await expect(
      service.receiveWebhook({
        sourceSlug: customSrc.sourceSlug,
        rawBody,
        headers: {
          'x-kestrelmq-timestamp': String(customSig.timestamp),
          'x-kestrelmq-signature': customSig.signature,
        },
        nowMs: fixedNowMs,
      }),
    ).resolves.toMatchObject({ received: true });

    // 5. NONE valid
    const noneSrc = makeSource(InboundProviderType.NONE);
    sourceFindUniqueMock.mockResolvedValueOnce(noneSrc);
    mockPersistSuccess();
    await expect(
      service.receiveWebhook({
        sourceSlug: noneSrc.sourceSlug,
        rawBody: undefined,
        headers: {},
        parsedBody: { ping: true },
        nowMs: fixedNowMs,
      }),
    ).resolves.toMatchObject({ received: true });

    // 404 on unknown slug
    sourceFindUniqueMock.mockResolvedValueOnce(null);
    await expect(
      service.receiveWebhook({ sourceSlug: 'missing-slug', rawBody, headers: {} }),
    ).rejects.toThrow(NotFoundException);

    // 401 on invalid signature or missing rawBody
    sourceFindUniqueMock.mockResolvedValueOnce(stripeSrc);
    await expect(
      service.receiveWebhook({
        sourceSlug: stripeSrc.sourceSlug,
        rawBody: undefined,
        headers: { 'stripe-signature': `t=${fixedNowSec},v1=${stripeSig}` },
        nowMs: fixedNowMs,
      }),
    ).rejects.toThrow(UnauthorizedException);

    sourceFindUniqueMock.mockResolvedValueOnce(githubSrc);
    await expect(
      service.receiveWebhook({
        sourceSlug: githubSrc.sourceSlug,
        rawBody,
        headers: { 'x-hub-signature-256': `sha256=${'f'.repeat(64)}` },
        nowMs: fixedNowMs,
      }),
    ).rejects.toThrow(UnauthorizedException);

    // Absorbs burst spikes exceeding maxRatePerSec without ingress 429 drops (egress is shaped by worker)
    const burstSource = { ...noneSrc, maxRatePerSec: 1 };
    for (let i = 0; i < 5; i += 1) {
      sourceFindUniqueMock.mockResolvedValueOnce(burstSource);
      mockPersistSuccess();
      const mockReq = {
        rawBody,
        headers: {},
        body: { burstIndex: i },
      } as unknown as RawBodyRequest<AuthenticatedRequest>;

      const burstRes = await gatewayController.receiveWebhook(burstSource.sourceSlug, mockReq);
      expect(burstRes.received).toBe(true);
      expect(burstRes.status).toBe(DeliveryStatus.PENDING);
    }
  });

  it('buffers deliveries in PAUSED status while source is paused and flushes paced batches on resume', async () => {
    const workspaceId = randomUUID();
    const sourceId = randomUUID();
    const now = new Date();

    // Pause source
    sourceFindFirstMock.mockResolvedValueOnce({ id: sourceId });
    sourceUpdateMock.mockResolvedValueOnce({
      id: sourceId,
      workspaceId,
      name: 'Shopify Store',
      sourceSlug: 'shopify-store',
      providerType: InboundProviderType.NONE,
      encryptedSigningSecret: null,
      iv: null,
      authTag: null,
      targetUrl: 'http://localhost:4100/shopify',
      maxRatePerSec: 2,
      isPaused: true,
      createdAt: now,
      updatedAt: now,
    });
    deliveryUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    const pausedSource = await sourcesController.pauseSource(workspaceId, sourceId);
    expect(pausedSource.isPaused).toBe(true);

    // Incoming webhook while isPaused = true -> stored as PAUSED without enqueueing
    sourceFindUniqueMock.mockResolvedValueOnce({
      id: sourceId,
      workspaceId,
      name: 'Shopify Store',
      sourceSlug: 'shopify-store',
      providerType: InboundProviderType.NONE,
      encryptedSigningSecret: null,
      iv: null,
      authTag: null,
      targetUrl: 'http://localhost:4100/shopify',
      maxRatePerSec: 2,
      isPaused: true,
      createdAt: now,
      updatedAt: now,
    });

    const bufferedEventId = randomUUID();
    const bufferedDeliveryId = randomUUID();
    eventCreateMock.mockResolvedValueOnce({ id: bufferedEventId });
    deliveryCreateMock.mockResolvedValueOnce({
      id: bufferedDeliveryId,
      status: DeliveryStatus.PAUSED,
      maxAttempts: 5,
    });

    const buffered = await service.receiveWebhook({
      sourceSlug: 'shopify-store',
      rawBody: Buffer.from('{"order":1}', 'utf8'),
      headers: {},
    });

    expect(buffered.status).toBe(DeliveryStatus.PAUSED);
    expect(buffered.buffered).toBe(true);
    expect(queueAddMock).not.toHaveBeenCalled();

    // Resume source with 3 buffered PAUSED deliveries and maxRatePerSec = 2:
    // indexes 0, 1 -> delay 0ms (PENDING); index 2 -> delay 1000ms (SCHEDULED)
    const d1 = { id: randomUUID(), eventId: randomUUID(), maxAttempts: 5 };
    const d2 = { id: randomUUID(), eventId: randomUUID(), maxAttempts: 5 };
    const d3 = { id: randomUUID(), eventId: randomUUID(), maxAttempts: 5 };

    sourceFindFirstMock.mockResolvedValueOnce({ id: sourceId });
    sourceUpdateMock.mockResolvedValueOnce({
      id: sourceId,
      workspaceId,
      name: 'Shopify Store',
      sourceSlug: 'shopify-store',
      providerType: InboundProviderType.NONE,
      encryptedSigningSecret: null,
      iv: null,
      authTag: null,
      targetUrl: 'http://localhost:4100/shopify',
      maxRatePerSec: 2,
      isPaused: false,
      createdAt: now,
      updatedAt: now,
    });
    deliveryFindManyMock.mockResolvedValueOnce([d1, d2, d3]);
    deliveryUpdateMock.mockResolvedValue({});

    const resumed = await sourcesController.resumeSource(workspaceId, sourceId);
    expect(resumed.source.isPaused).toBe(false);
    expect(resumed.resumedDeliveriesCount).toBe(3);
    expect(queueAddBulkMock).toHaveBeenCalledOnce();

    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as {
      name: string;
      data: DeliveryJobPayload;
      opts: { delay?: number; backoff: { type: string } };
    }[];

    expect(bulkJobs).toHaveLength(3);
    expect(bulkJobs[0]?.name).toBe(DELIVERY_JOB_NAMES.DELIVER_INBOUND);
    expect(bulkJobs[0]?.opts.delay).toBeUndefined();
    expect(bulkJobs[1]?.opts.delay).toBeUndefined();
    expect(bulkJobs[2]?.opts.delay).toBe(1_000);
    expect(bulkJobs[2]?.opts.backoff.type).toBe(KESTREL_BACKOFF_TYPE);
  });

  it('validates CreateInboundSourceDto rules', async () => {
    const valid = plainToInstance(CreateInboundSourceDto, {
      name: 'GitHub Repo',
      sourceSlug: 'gh-repo-events',
      providerType: InboundProviderType.GITHUB,
      signingSecret: randomBytes(16).toString('hex'),
      targetUrl: 'http://localhost:3001/hooks',
      maxRatePerSec: 25,
    });
    expect(await validate(valid)).toHaveLength(0);

    const invalid = plainToInstance(CreateInboundSourceDto, {
      name: '',
      sourceSlug: 'UPPERCASE_BAD_SLUG',
      providerType: InboundProviderType.GITHUB,
      targetUrl: 'ftp://bad-protocol.local',
      maxRatePerSec: 0,
    });
    const errors = await validate(invalid);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});
