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
  type MailgunCredentials,
  parseMailgunCredentials,
  type ProviderCredentials,
} from '../schemas/provider-credentials.schema.js';

const MAILGUN_US_BASE_URL = 'https://api.mailgun.net' as const;
const MAILGUN_EU_BASE_URL = 'https://api.eu.mailgun.net' as const;

function resolveMailgunBaseUrl(credentials: MailgunCredentials): string {
  if (credentials.baseUrl) {
    return credentials.baseUrl.replace(/\/+$/, '');
  }
  return credentials.region === 'EU' ? MAILGUN_EU_BASE_URL : MAILGUN_US_BASE_URL;
}

function buildBasicAuthHeader(apiKey: string): string {
  const encoded = Buffer.from(`api:${apiKey}`, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

@Injectable()
export class MailgunAdapter extends NotificationProvider {
  override readonly provider = IntegrationProvider.MAILGUN;
  override readonly channel = IntegrationChannel.EMAIL;

  override async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    const credentials = parseMailgunCredentials(request.credentials);
    const recipientEmail = request.target?.trim();

    if (!recipientEmail) {
      throw new ProviderConfigurationError(
        this.provider,
        'Mailgun target recipient email address is required',
      );
    }

    const subject = request.content.subject?.trim();
    if (!subject) {
      throw new ProviderConfigurationError(this.provider, 'Mailgun email subject is required');
    }

    const html =
      request.content.html && request.content.html.trim().length > 0
        ? request.content.html
        : request.content.body.trim().length > 0
          ? request.content.body
          : undefined;
    const text =
      request.content.text && request.content.text.trim().length > 0
        ? request.content.text
        : undefined;

    if (!html && !text) {
      throw new ProviderConfigurationError(
        this.provider,
        'Mailgun email requires non-empty html or text content',
      );
    }

    const form = new URLSearchParams();
    form.set('from', credentials.from);
    form.set('to', recipientEmail);
    form.set('subject', subject);
    if (html) {
      form.set('html', html);
    }
    if (text) {
      form.set('text', text);
    }

    const baseUrl = resolveMailgunBaseUrl(credentials);
    const endpoint = `${baseUrl}/v3/${encodeURIComponent(credentials.domain)}/messages`;

    return this.#executeMailgunRequest(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: buildBasicAuthHeader(credentials.apiKey),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
      credentials.apiKey,
    );
  }

  override async testConnection(
    credentials: ProviderCredentials,
    context: ProviderTestContext,
  ): Promise<ProviderSendResult> {
    const parsed = parseMailgunCredentials(credentials);
    const targetEmail = context.target?.trim();

    if (targetEmail) {
      return this.send({
        credentials: parsed,
        target: targetEmail,
        content: {
          subject: 'KestrelMQ Connectivity Test',
          body: '<p><strong>KestrelMQ</strong> Mailgun integration connectivity verified.</p>',
          html: '<p><strong>KestrelMQ</strong> Mailgun integration connectivity verified.</p>',
          text: 'KestrelMQ Mailgun integration connectivity verified.',
        },
      });
    }

    const baseUrl = resolveMailgunBaseUrl(parsed);
    const endpoint = `${baseUrl}/v3/domains/${encodeURIComponent(parsed.domain)}`;

    return this.#executeMailgunRequest(
      endpoint,
      {
        method: 'GET',
        headers: {
          Authorization: buildBasicAuthHeader(parsed.apiKey),
        },
      },
      parsed.apiKey,
    );
  }

  async #executeMailgunRequest(
    endpoint: string,
    init: Omit<RequestInit, 'signal'>,
    apiKey: string,
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
      const rawMessage = error instanceof Error ? error.message : 'Mailgun REST API network error';
      throw new ProviderDeliveryError({
        provider: this.provider,
        message: redactSecretsFromText(`Mailgun request failed: ${rawMessage}`, [apiKey]),
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
        message: `Mailgun API responded with HTTP ${response.status}`,
        retryable: isRetryableStatusCode(response.status),
        statusCode: response.status,
        responseBody: redactSecretsFromText(responseBody, [apiKey]),
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
