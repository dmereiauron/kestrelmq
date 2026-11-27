import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { CryptoService } from '../../../common/crypto/crypto.service.js';
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
  parseWebhookCredentials,
  type ProviderCredentials,
} from '../schemas/provider-credentials.schema.js';

const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'content-type',
  'user-agent',
  'x-kestrelmq-timestamp',
  'x-kestrelmq-signature',
]);

function isValidHttpUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

@Injectable()
export class WebhookAdapter extends NotificationProvider {
  override readonly provider = IntegrationProvider.CUSTOM_WEBHOOK;
  override readonly channel = IntegrationChannel.WEBHOOK;

  readonly #cryptoService: CryptoService;

  constructor(cryptoService: CryptoService) {
    super();
    this.#cryptoService = cryptoService;
  }

  override async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    const credentials = parseWebhookCredentials(request.credentials);
    const targetUrl =
      request.target && request.target.trim().length > 0 ? request.target.trim() : credentials.url;

    if (!isValidHttpUrl(targetUrl)) {
      throw new ProviderConfigurationError(
        this.provider,
        'Webhook target must be a valid http:// or https:// URL',
      );
    }

    const signingSecret =
      request.metadata?.workspaceSigningSecret?.trim() || credentials.signingSecret?.trim();

    if (!signingSecret) {
      throw new ProviderConfigurationError(
        this.provider,
        'Webhook signing secret is required for outbound HMAC-SHA256 signing',
      );
    }

    const rawBody = request.content.body;
    const { timestamp, signature } = this.#cryptoService.signWebhookPayload(
      rawBody,
      signingSecret,
      request.metadata?.timestampSec,
    );

    const headers: Record<string, string> = {};
    if (credentials.headers) {
      for (const [key, value] of Object.entries(credentials.headers)) {
        if (!RESERVED_HEADER_NAMES.has(key.toLowerCase())) {
          headers[key] = value;
        }
      }
    }

    headers['Content-Type'] = 'application/json';
    headers['User-Agent'] = 'KestrelMQ-Webhook/1.0';
    headers['X-KestrelMQ-Timestamp'] = String(timestamp);
    headers['X-KestrelMQ-Signature'] = signature;

    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      const durationMs = Math.round(performance.now() - startedAt);
      const rawMessage = error instanceof Error ? error.message : 'Outbound webhook network error';
      throw new ProviderDeliveryError({
        provider: this.provider,
        message: redactSecretsFromText(`Webhook request failed: ${rawMessage}`, [signingSecret]),
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
        message: `Webhook endpoint responded with HTTP ${response.status}`,
        retryable: isRetryableStatusCode(response.status),
        statusCode: response.status,
        responseBody,
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

  override async testConnection(
    credentials: ProviderCredentials,
    context: ProviderTestContext,
  ): Promise<ProviderSendResult> {
    const testBody = JSON.stringify({
      event: 'kestrelmq.integration.test',
      timestamp: new Date().toISOString(),
      message: 'KestrelMQ connectivity verification ping',
    });

    return this.send({
      credentials,
      target: context.target,
      content: { body: testBody },
      metadata: {
        workspaceSigningSecret: context.workspaceSigningSecret,
      },
    });
  }
}
