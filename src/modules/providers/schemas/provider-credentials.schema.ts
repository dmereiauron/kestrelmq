import { z } from 'zod';
import { IntegrationChannel, IntegrationProvider } from '../../../generated/prisma/enums.js';
import { ProviderConfigurationError } from '../errors/provider-delivery.error.js';

export const CHANNEL_PROVIDER_MAP: Readonly<Record<IntegrationProvider, IntegrationChannel>> = {
  [IntegrationProvider.MAILGUN]: IntegrationChannel.EMAIL,
  [IntegrationProvider.RESEND]: IntegrationChannel.EMAIL,
  [IntegrationProvider.SMTP]: IntegrationChannel.EMAIL,
  [IntegrationProvider.TELEGRAM_BOT]: IntegrationChannel.TELEGRAM,
  [IntegrationProvider.CUSTOM_WEBHOOK]: IntegrationChannel.WEBHOOK,
};

export const webhookCredentialsSchema = z.object({
  url: z.url({
    protocol: /^https?$/,
    error: 'Webhook url must be a valid http:// or https:// URL',
  }),
  headers: z.record(z.string(), z.string()).optional(),
  signingSecret: z.string().trim().min(1).optional(),
});

export const telegramCredentialsSchema = z.object({
  botToken: z.string().trim().min(1, {
    error: 'Telegram botToken must be a non-empty string',
  }),
  defaultChatId: z.string().trim().min(1).optional(),
  baseUrl: z
    .url({
      protocol: /^https?$/,
      error: 'Telegram baseUrl must be a valid http:// or https:// URL',
    })
    .optional(),
});

export const mailgunCredentialsSchema = z.object({
  apiKey: z.string().trim().min(1, {
    error: 'Mailgun apiKey must be a non-empty string',
  }),
  domain: z.string().trim().min(1, {
    error: 'Mailgun domain must be a non-empty string',
  }),
  from: z.string().trim().min(1, {
    error: 'Mailgun sender (from) must be a non-empty string',
  }),
  region: z.enum(['US', 'EU']).default('US'),
  baseUrl: z
    .url({
      protocol: /^https?$/,
      error: 'Mailgun baseUrl must be a valid http:// or https:// URL',
    })
    .optional(),
});

export type WebhookCredentials = z.infer<typeof webhookCredentialsSchema>;
export type TelegramCredentials = z.infer<typeof telegramCredentialsSchema>;
export type MailgunCredentials = z.infer<typeof mailgunCredentialsSchema>;

export type ProviderCredentials = WebhookCredentials | TelegramCredentials | MailgunCredentials;

export function validateChannelProviderPair(
  channel: IntegrationChannel,
  provider: IntegrationProvider,
): void {
  const expectedChannel = CHANNEL_PROVIDER_MAP[provider];
  if (expectedChannel !== channel) {
    throw new ProviderConfigurationError(
      provider,
      `Provider "${provider}" requires channel "${expectedChannel}", received "${channel}"`,
    );
  }
}

export function parseWebhookCredentials(raw: unknown): WebhookCredentials {
  const parsed = webhookCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderConfigurationError(
      IntegrationProvider.CUSTOM_WEBHOOK,
      `Invalid CUSTOM_WEBHOOK credentials: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function parseTelegramCredentials(raw: unknown): TelegramCredentials {
  const parsed = telegramCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderConfigurationError(
      IntegrationProvider.TELEGRAM_BOT,
      `Invalid TELEGRAM_BOT credentials: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function parseMailgunCredentials(raw: unknown): MailgunCredentials {
  const parsed = mailgunCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderConfigurationError(
      IntegrationProvider.MAILGUN,
      `Invalid MAILGUN credentials: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function parseProviderCredentials(
  provider: IntegrationProvider,
  raw: unknown,
): ProviderCredentials {
  switch (provider) {
    case IntegrationProvider.CUSTOM_WEBHOOK:
      return parseWebhookCredentials(raw);
    case IntegrationProvider.TELEGRAM_BOT:
      return parseTelegramCredentials(raw);
    case IntegrationProvider.MAILGUN:
      return parseMailgunCredentials(raw);
    case IntegrationProvider.RESEND:
    case IntegrationProvider.SMTP:
      throw new ProviderConfigurationError(
        provider,
        `Provider "${provider}" is not supported yet`,
      );
  }
}
