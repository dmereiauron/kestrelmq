import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { IntegrationChannel, IntegrationProvider } from '../../generated/prisma/enums.js';
import { MailgunAdapter } from './adapters/mailgun.adapter.js';
import { TelegramAdapter } from './adapters/telegram.adapter.js';
import { WebhookAdapter } from './adapters/webhook.adapter.js';
import { ProviderConfigurationError } from './errors/provider-delivery.error.js';
import { ProviderFactory } from './provider.factory.js';
import {
  parseProviderCredentials,
  validateChannelProviderPair,
} from './schemas/provider-credentials.schema.js';

describe('ProviderFactory & credential schemas', () => {
  let webhookAdapter: WebhookAdapter;
  let telegramAdapter: TelegramAdapter;
  let mailgunAdapter: MailgunAdapter;
  let factory: ProviderFactory;

  beforeEach(() => {
    const masterKeyHex = randomBytes(32).toString('hex');
    const configService = {
      get: vi.fn((key: keyof EnvConfig) =>
        key === 'ENCRYPTION_MASTER_KEY' ? masterKeyHex : undefined,
      ),
    } as unknown as ConfigService<EnvConfig, true>;

    webhookAdapter = new WebhookAdapter(new CryptoService(configService));
    telegramAdapter = new TelegramAdapter();
    mailgunAdapter = new MailgunAdapter();
    factory = new ProviderFactory([webhookAdapter, telegramAdapter, mailgunAdapter]);
  });

  it('resolves registered adapters via Strategy pattern and lists supported providers', () => {
    expect(factory.hasProvider(IntegrationProvider.CUSTOM_WEBHOOK)).toBe(true);
    expect(factory.hasProvider(IntegrationProvider.TELEGRAM_BOT)).toBe(true);
    expect(factory.hasProvider(IntegrationProvider.MAILGUN)).toBe(true);
    expect(factory.hasProvider(IntegrationProvider.RESEND)).toBe(false);

    expect(factory.getProvider(IntegrationProvider.CUSTOM_WEBHOOK)).toBe(webhookAdapter);
    expect(factory.getProvider(IntegrationProvider.TELEGRAM_BOT)).toBe(telegramAdapter);
    expect(factory.getProvider(IntegrationProvider.MAILGUN)).toBe(mailgunAdapter);
    expect(factory.getSupportedProviders()).toEqual([
      IntegrationProvider.CUSTOM_WEBHOOK,
      IntegrationProvider.TELEGRAM_BOT,
      IntegrationProvider.MAILGUN,
    ]);
  });

  it('rejects duplicate adapter registrations and unsupported providers', () => {
    expect(() => new ProviderFactory([telegramAdapter, telegramAdapter])).toThrow(
      /Duplicate NotificationProvider/,
    );

    expect(() => factory.getProvider(IntegrationProvider.SMTP)).toThrow(ProviderConfigurationError);
  });

  it('validates channel/provider pairings and provider credential schemas', () => {
    expect(() =>
      validateChannelProviderPair(IntegrationChannel.EMAIL, IntegrationProvider.MAILGUN),
    ).not.toThrow();

    expect(() =>
      validateChannelProviderPair(IntegrationChannel.TELEGRAM, IntegrationProvider.MAILGUN),
    ).toThrow(ProviderConfigurationError);

    expect(() =>
      parseProviderCredentials(IntegrationProvider.CUSTOM_WEBHOOK, { url: 'not-a-url' }),
    ).toThrow(ProviderConfigurationError);

    expect(() =>
      parseProviderCredentials(IntegrationProvider.TELEGRAM_BOT, { botToken: '' }),
    ).toThrow(ProviderConfigurationError);

    expect(() =>
      parseProviderCredentials(IntegrationProvider.MAILGUN, { apiKey: '', domain: '', from: '' }),
    ).toThrow(ProviderConfigurationError);

    expect(() =>
      parseProviderCredentials(IntegrationProvider.RESEND, { apiKey: 'test' }),
    ).toThrow(ProviderConfigurationError);
  });
});
