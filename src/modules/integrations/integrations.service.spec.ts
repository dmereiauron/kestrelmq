import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { IntegrationChannel, IntegrationProvider } from '../../generated/prisma/enums.js';
import { MailgunAdapter } from '../providers/adapters/mailgun.adapter.js';
import { TelegramAdapter } from '../providers/adapters/telegram.adapter.js';
import { WebhookAdapter } from '../providers/adapters/webhook.adapter.js';
import {
  ProviderConfigurationError,
  ProviderDeliveryError,
} from '../providers/errors/provider-delivery.error.js';
import { ProviderFactory } from '../providers/provider.factory.js';
import { CreateIntegrationDto } from './dto/create-integration.dto.js';
import { TestIntegrationDto } from './dto/test-integration.dto.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';

describe('IntegrationsService & IntegrationsController', () => {
  let cryptoService: CryptoService;
  let webhookAdapter: WebhookAdapter;
  let telegramAdapter: TelegramAdapter;
  let mailgunAdapter: MailgunAdapter;
  let providerFactory: ProviderFactory;
  let integrationCreateMock: ReturnType<typeof vi.fn>;
  let integrationFindManyMock: ReturnType<typeof vi.fn>;
  let integrationFindFirstMock: ReturnType<typeof vi.fn>;
  let integrationDeleteManyMock: ReturnType<typeof vi.fn>;
  let service: IntegrationsService;
  let controller: IntegrationsController;

  beforeEach(() => {
    const masterKeyHex = randomBytes(32).toString('hex');
    const configService = {
      get: vi.fn((key: keyof EnvConfig) =>
        key === 'ENCRYPTION_MASTER_KEY' ? masterKeyHex : undefined,
      ),
    } as unknown as ConfigService<EnvConfig, true>;

    cryptoService = new CryptoService(configService);
    webhookAdapter = new WebhookAdapter(cryptoService);
    telegramAdapter = new TelegramAdapter();
    mailgunAdapter = new MailgunAdapter();
    providerFactory = new ProviderFactory([webhookAdapter, telegramAdapter, mailgunAdapter]);

    integrationCreateMock = vi.fn();
    integrationFindManyMock = vi.fn();
    integrationFindFirstMock = vi.fn();
    integrationDeleteManyMock = vi.fn();

    const prismaService = {
      integration: {
        create: integrationCreateMock,
        findMany: integrationFindManyMock,
        findFirst: integrationFindFirstMock,
        deleteMany: integrationDeleteManyMock,
      },
    } as unknown as PrismaService;

    service = new IntegrationsService(prismaService, cryptoService, providerFactory);
    controller = new IntegrationsController(service);
  });

  it('encrypts credentials via CryptoService.encryptDetached and never exposes ciphertext/iv/authTag in responses', async () => {
    const workspaceId = randomUUID();
    const integrationId = randomUUID();
    const apiKey = `key-${randomBytes(16).toString('hex')}`;
    const now = new Date();

    let persistedData: {
      encryptedCredentials: string;
      iv: string;
      authTag: string;
      provider: IntegrationProvider;
    } | null = null;

    integrationCreateMock.mockImplementation(
      async ({
        data,
      }: {
        data: {
          workspaceId: string;
          name: string;
          channel: IntegrationChannel;
          provider: IntegrationProvider;
          encryptedCredentials: string;
          iv: string;
          authTag: string;
          isActive: boolean;
        };
      }) => {
        persistedData = {
          provider: data.provider,
          encryptedCredentials: data.encryptedCredentials,
          iv: data.iv,
          authTag: data.authTag,
        };
        return {
          id: integrationId,
          workspaceId: data.workspaceId,
          name: data.name,
          channel: data.channel,
          provider: data.provider,
          isActive: data.isActive,
          createdAt: now,
          updatedAt: now,
        };
      },
    );

    const created = await controller.createIntegration(workspaceId, {
      name: 'Transactional Mailgun',
      channel: IntegrationChannel.EMAIL,
      provider: IntegrationProvider.MAILGUN,
      credentials: {
        apiKey,
        domain: 'mg.kestrelmq.io',
        from: 'KestrelMQ <noreply@mg.kestrelmq.io>',
        region: 'US',
      },
    });

    expect(created).toEqual({
      id: integrationId,
      workspaceId,
      name: 'Transactional Mailgun',
      channel: IntegrationChannel.EMAIL,
      provider: IntegrationProvider.MAILGUN,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    expect('encryptedCredentials' in created).toBe(false);
    expect('iv' in created).toBe(false);
    expect('authTag' in created).toBe(false);
    expect('credentials' in created).toBe(false);

    expect(persistedData).not.toBeNull();
    expect(persistedData!.encryptedCredentials).not.toContain(apiKey);

    const decrypted = service.decryptIntegrationCredentials(persistedData!);
    expect(decrypted).toEqual({
      apiKey,
      domain: 'mg.kestrelmq.io',
      from: 'KestrelMQ <noreply@mg.kestrelmq.io>',
      region: 'US',
    });
  });

  it('rejects empty names, mismatched channel/provider pairs, unsupported providers, and invalid credentials with 400', async () => {
    const workspaceId = randomUUID();

    await expect(
      service.createIntegration(workspaceId, {
        name: '   ',
        channel: IntegrationChannel.WEBHOOK,
        provider: IntegrationProvider.CUSTOM_WEBHOOK,
        credentials: { url: 'https://hooks.example.com/in' },
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.createIntegration(workspaceId, {
        name: 'Mismatched',
        channel: IntegrationChannel.EMAIL,
        provider: IntegrationProvider.TELEGRAM_BOT,
        credentials: { botToken: randomBytes(12).toString('hex') },
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.createIntegration(workspaceId, {
        name: 'Unsupported Resend',
        channel: IntegrationChannel.EMAIL,
        provider: IntegrationProvider.RESEND,
        credentials: { apiKey: randomBytes(12).toString('hex') },
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.createIntegration(workspaceId, {
        name: 'Broken Webhook',
        channel: IntegrationChannel.WEBHOOK,
        provider: IntegrationProvider.CUSTOM_WEBHOOK,
        credentials: { url: 'ftp://invalid.url' },
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lists and deletes workspace-scoped integrations and returns 404 on cross-workspace delete', async () => {
    const workspaceId = randomUUID();
    const integrationId = randomUUID();
    const now = new Date();

    integrationFindManyMock.mockResolvedValueOnce([
      {
        id: integrationId,
        workspaceId,
        name: 'Primary Webhook',
        channel: IntegrationChannel.WEBHOOK,
        provider: IntegrationProvider.CUSTOM_WEBHOOK,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const list = await controller.listIntegrations(workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(integrationId);

    integrationDeleteManyMock.mockResolvedValueOnce({ count: 1 });
    await expect(controller.deleteIntegration(workspaceId, integrationId)).resolves.toBeUndefined();

    integrationDeleteManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(controller.deleteIntegration(workspaceId, randomUUID())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('executes live /test connectivity ping and maps config errors to 400 and upstream errors to 502', async () => {
    const workspaceId = randomUUID();
    const integrationId = randomUUID();
    const signingSecret = `whsec_${randomBytes(24).toString('hex')}`;

    // Missing integration -> 404
    integrationFindFirstMock.mockResolvedValueOnce(null);
    await expect(controller.testIntegration(workspaceId, integrationId, {})).rejects.toThrow(
      NotFoundException,
    );

    const encrypted = cryptoService.encryptDetached(
      JSON.stringify({ url: 'https://hooks.example.com/ping' }),
    );
    const dbRecord = {
      id: integrationId,
      provider: IntegrationProvider.CUSTOM_WEBHOOK,
      encryptedCredentials: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      workspace: {
        webhookSigningSecret: signingSecret,
      },
    };

    // 200 OK ping
    integrationFindFirstMock.mockResolvedValueOnce(dbRecord);
    const testConnectionSpy = vi.spyOn(webhookAdapter, 'testConnection').mockResolvedValueOnce({
      provider: IntegrationProvider.CUSTOM_WEBHOOK,
      statusCode: 200,
      responseBody: '{"pong":true}',
      durationMs: 37,
    });

    const pingResult = await controller.testIntegration(workspaceId, integrationId, {});
    expect(pingResult).toEqual({
      ok: true,
      integrationId,
      provider: IntegrationProvider.CUSTOM_WEBHOOK,
      statusCode: 200,
      durationMs: 37,
    });
    expect(testConnectionSpy).toHaveBeenCalledWith(
      { url: 'https://hooks.example.com/ping' },
      { target: undefined, workspaceSigningSecret: signingSecret },
    );

    // ProviderConfigurationError -> 400 BadRequestException
    integrationFindFirstMock.mockResolvedValueOnce(dbRecord);
    testConnectionSpy.mockRejectedValueOnce(
      new ProviderConfigurationError(IntegrationProvider.CUSTOM_WEBHOOK, 'Invalid target URL'),
    );
    await expect(
      controller.testIntegration(workspaceId, integrationId, { target: 'bad' }),
    ).rejects.toThrow(BadRequestException);

    // ProviderDeliveryError -> 502 BadGatewayException
    integrationFindFirstMock.mockResolvedValueOnce(dbRecord);
    testConnectionSpy.mockRejectedValueOnce(
      new ProviderDeliveryError({
        provider: IntegrationProvider.CUSTOM_WEBHOOK,
        message: 'Webhook endpoint responded with HTTP 500',
        retryable: true,
        statusCode: 500,
        responseBody: 'Internal Error',
        durationMs: 112,
      }),
    );
    await expect(controller.testIntegration(workspaceId, integrationId, {})).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('validates CreateIntegrationDto and TestIntegrationDto class-validator constraints', async () => {
    expect(
      await validate(
        plainToInstance(CreateIntegrationDto, {
          workspaceId: randomUUID(),
          name: 'Alerts Bot',
          channel: IntegrationChannel.TELEGRAM,
          provider: IntegrationProvider.TELEGRAM_BOT,
          credentials: { botToken: randomBytes(12).toString('hex') },
          isActive: true,
        }),
      ),
    ).toHaveLength(0);

    expect(
      (
        await validate(
          plainToInstance(CreateIntegrationDto, {
            name: '',
            channel: 'INVALID',
            provider: 'INVALID',
            credentials: {},
          }),
        )
      ).length,
    ).toBeGreaterThanOrEqual(3);

    expect(
      await validate(plainToInstance(TestIntegrationDto, { target: 'ops@example.com' })),
    ).toHaveLength(0);
  });
});
