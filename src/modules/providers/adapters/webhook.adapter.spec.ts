import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../../common/crypto/crypto.service.js';
import type { EnvConfig } from '../../../config/env.validation.js';
import { IntegrationChannel, IntegrationProvider } from '../../../generated/prisma/enums.js';
import {
  ProviderConfigurationError,
  ProviderDeliveryError,
} from '../errors/provider-delivery.error.js';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../interfaces/notification-provider.interface.js';
import { WebhookAdapter } from './webhook.adapter.js';

describe('WebhookAdapter', () => {
  let cryptoService: CryptoService;
  let adapter: WebhookAdapter;
  let workspaceSigningSecret: string;

  beforeEach(() => {
    const masterKeyHex = randomBytes(32).toString('hex');
    workspaceSigningSecret = `whsec_${randomBytes(24).toString('hex')}`;

    const configService = {
      get: vi.fn((key: keyof EnvConfig) =>
        key === 'ENCRYPTION_MASTER_KEY' ? masterKeyHex : undefined,
      ),
    } as unknown as ConfigService<EnvConfig, true>;

    cryptoService = new CryptoService(configService);
    adapter = new WebhookAdapter(cryptoService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends HTTP POST with 10s AbortSignal timeout and verifiable v1= HMAC-SHA256 headers while blocking reserved header overrides', async () => {
    expect(adapter.provider).toBe(IntegrationProvider.CUSTOM_WEBHOOK);
    expect(adapter.channel).toBe(IntegrationChannel.WEBHOOK);

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"received":true}', { status: 200 }));

    const fixedTimestamp = Math.floor(Date.now() / 1000);
    const jsonBody = JSON.stringify({ event: 'order.paid', orderId: 'ord_99' });

    const result = await adapter.send({
      credentials: {
        url: 'https://hooks.client.example/kestrel',
        headers: {
          'X-Custom-Source': 'checkout',
          'x-kestrelmq-signature': 'v1=spoofed',
          'content-type': 'text/plain',
        },
      },
      content: { body: jsonBody },
      metadata: {
        workspaceSigningSecret,
        timestampSec: fixedTimestamp,
      },
    });

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_PROVIDER_TIMEOUT_MS);
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe('https://hooks.client.example/kestrel');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(jsonBody);
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Custom-Source']).toBe('checkout');
    expect(headers['X-KestrelMQ-Timestamp']).toBe(String(fixedTimestamp));
    expect(headers['X-KestrelMQ-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(headers['x-kestrelmq-signature']).toBeUndefined();

    const verified = cryptoService.verifyWebhookSignature(
      jsonBody,
      headers['X-KestrelMQ-Signature']!,
      headers['X-KestrelMQ-Timestamp']!,
      workspaceSigningSecret,
    );
    expect(verified).toBe(true);

    expect(result.provider).toBe(IntegrationProvider.CUSTOM_WEBHOOK);
    expect(result.statusCode).toBe(200);
    expect(result.responseBody).toBe('{"received":true}');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('classifies 4xx as fatal, 429/5xx/network timeouts as retryable, and rejects missing secrets or invalid target URLs', async () => {
    // Missing signing secret -> ProviderConfigurationError
    await expect(
      adapter.send({
        credentials: { url: 'https://hooks.client.example/ingest' },
        content: { body: '{}' },
      }),
    ).rejects.toThrow(ProviderConfigurationError);

    // Invalid target override URL -> ProviderConfigurationError
    await expect(
      adapter.send({
        credentials: { url: 'https://hooks.client.example/ingest' },
        target: 'ftp://invalid.protocol/hook',
        content: { body: '{}' },
        metadata: { workspaceSigningSecret },
      }),
    ).rejects.toThrow(ProviderConfigurationError);

    // 404 -> non-retryable ProviderDeliveryError
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not Found', { status: 404 }),
    );
    await expect(
      adapter.send({
        credentials: { url: 'https://hooks.client.example/missing' },
        content: { body: '{}' },
        metadata: { workspaceSigningSecret },
      }),
    ).rejects.toMatchObject({
      name: 'ProviderDeliveryError',
      retryable: false,
      statusCode: 404,
      responseBody: 'Not Found',
    });

    // 503 -> retryable ProviderDeliveryError
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Service Unavailable', { status: 503 }),
    );
    await expect(
      adapter.send({
        credentials: { url: 'https://hooks.client.example/flaky' },
        content: { body: '{}' },
        metadata: { workspaceSigningSecret },
      }),
    ).rejects.toMatchObject({
      name: 'ProviderDeliveryError',
      retryable: true,
      statusCode: 503,
    });

    // Timeout / network rejection -> retryable ProviderDeliveryError with null statusCode
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );
    let caughtError: unknown;
    try {
      await adapter.testConnection(
        { url: 'https://hooks.client.example/slow' },
        { workspaceSigningSecret },
      );
    } catch (err: unknown) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(ProviderDeliveryError);
    expect((caughtError as ProviderDeliveryError).retryable).toBe(true);
    expect((caughtError as ProviderDeliveryError).statusCode).toBeNull();
  });
});
