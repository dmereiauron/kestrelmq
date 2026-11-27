import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { IntegrationChannel, IntegrationProvider } from '../../../generated/prisma/enums.js';
import {
  isRetryableStatusCode,
  ProviderConfigurationError,
  ProviderDeliveryError,
  redactSecretsFromText,
} from '../errors/provider-delivery.error.js';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  NotificationProvider,
  type ProviderSendRequest,
  type ProviderSendResult,
  type ProviderTestContext,
} from '../interfaces/notification-provider.interface.js';
import {
  parseTelegramCredentials,
  type ProviderCredentials,
} from '../schemas/provider-credentials.schema.js';

const DEFAULT_TELEGRAM_BASE_URL = 'https://api.telegram.org' as const;

@Injectable()
export class TelegramAdapter extends NotificationProvider {
  override readonly provider = IntegrationProvider.TELEGRAM_BOT;
  override readonly channel = IntegrationChannel.TELEGRAM;

  override async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    const credentials = parseTelegramCredentials(request.credentials);
    const chatId =
      request.target && request.target.trim().length > 0
        ? request.target.trim()
        : credentials.defaultChatId?.trim();

    if (!chatId) {
      throw new ProviderConfigurationError(
        this.provider,
        'Telegram chatId is required via target or credentials.defaultChatId',
      );
    }

    if (request.content.body.trim().length === 0) {
      throw new ProviderConfigurationError(
        this.provider,
        'Telegram message body must be a non-empty string',
      );
    }

    const baseUrl = (credentials.baseUrl ?? DEFAULT_TELEGRAM_BASE_URL).replace(/\/+$/, '');
    const endpoint = `${baseUrl}/bot${credentials.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text: request.content.body,
      parse_mode: 'HTML',
    });

    return this.#executeTelegramRequest(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body,
      },
      credentials.botToken,
    );
  }

  override async testConnection(
    credentials: ProviderCredentials,
    context: ProviderTestContext,
  ): Promise<ProviderSendResult> {
    const parsed = parseTelegramCredentials(credentials);
    const effectiveChatId =
      context.target && context.target.trim().length > 0
        ? context.target.trim()
        : parsed.defaultChatId?.trim();

    if (effectiveChatId) {
      return this.send({
        credentials: parsed,
        target: effectiveChatId,
        content: {
          body: '<b>KestrelMQ</b> connectivity verification ping succeeded.',
        },
      });
    }

    const baseUrl = (parsed.baseUrl ?? DEFAULT_TELEGRAM_BASE_URL).replace(/\/+$/, '');
    const endpoint = `${baseUrl}/bot${parsed.botToken}/getMe`;

    return this.#executeTelegramRequest(endpoint, { method: 'GET' }, parsed.botToken);
  }

  async #executeTelegramRequest(
    endpoint: string,
    init: Omit<RequestInit, 'signal'>,
    botToken: string,
  ): Promise<ProviderSendResult> {
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(endpoint, {
        ...init,
        signal: AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      const durationMs = Math.round(performance.now() - startedAt);
      const rawMessage = error instanceof Error ? error.message : 'Telegram Bot API network error';
      throw new ProviderDeliveryError({
        provider: this.provider,
        message: redactSecretsFromText(`Telegram request failed: ${rawMessage}`, [botToken]),
        retryable: true,
        statusCode: null,
        responseBody: null,
        durationMs,
        cause: error,
      });
    }

    const responseBody = await response.text();
    const durationMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      throw new ProviderDeliveryError({
        provider: this.provider,
        message: `Telegram Bot API responded with HTTP ${response.status}`,
        retryable: isRetryableStatusCode(response.status),
        statusCode: response.status,
        responseBody: redactSecretsFromText(responseBody, [botToken]),
        durationMs,
      });
    }

    return {
      provider: this.provider,
      statusCode: response.status,
      responseBody,
      durationMs,
    };
  }
}
