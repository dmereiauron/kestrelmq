import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationChannel, IntegrationProvider } from '../../../generated/prisma/enums.js';
import {
  ProviderConfigurationError,
  ProviderDeliveryError,
} from '../errors/provider-delivery.error.js';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../interfaces/notification-provider.interface.js';
import { MailgunAdapter } from './mailgun.adapter.js';

describe('MailgunAdapter', () => {
  let adapter: MailgunAdapter;
  let apiKey: string;

  beforeEach(() => {
    adapter = new MailgunAdapter();
    apiKey = `key-${randomBytes(16).toString('hex')}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends form-urlencoded POST to Mailgun v3 messages endpoint with Basic auth and 10s timeout', async () => {
    expect(adapter.provider).toBe(IntegrationProvider.MAILGUN);
    expect(adapter.channel).toBe(IntegrationChannel.EMAIL);

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"id":"<msg@mg.example.com>","message":"Queued."}', { status: 200 }),
    );

    const result = await adapter.send({
      credentials: {
        apiKey,
        domain: 'mg.example.com',
        from: 'KestrelMQ <noreply@mg.example.com>',
        region: 'EU',
      },
      target: 'customer@example.com',
      content: {
        subject: 'Receipt #501',
        body: '<p>Thank you</p>',
        html: '<p>Thank you</p>',
        text: 'Thank you',
      },
    });

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_PROVIDER_TIMEOUT_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    const expectedBasic = `Basic ${Buffer.from(`api:${apiKey}`, 'utf8').toString('base64')}`;
    expect(headers['Authorization']).toBe(expectedBasic);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const parsedForm = new URLSearchParams(init?.body as string);
    expect(parsedForm.get('from')).toBe('KestrelMQ <noreply@mg.example.com>');
    expect(parsedForm.get('to')).toBe('customer@example.com');
    expect(parsedForm.get('subject')).toBe('Receipt #501');
    expect(parsedForm.get('html')).toBe('<p>Thank you</p>');
    expect(parsedForm.get('text')).toBe('Thank you');

    expect(result.statusCode).toBe(200);
  });

  it('supports testConnection via messages when target is provided and domains lookup when omitted', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"message":"Queued"}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"domain":{"name":"mg.example.com"}}', { status: 200 }));

    const withTarget = await adapter.testConnection(
      {
        apiKey,
        domain: 'mg.example.com',
        from: 'noreply@mg.example.com',
        region: 'US',
      },
      { target: 'qa@example.com' },
    );
    expect(withTarget.statusCode).toBe(200);
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.mailgun.net/v3/mg.example.com/messages');

    const domainCheck = await adapter.testConnection(
      {
        apiKey,
        domain: 'mg.example.com',
        from: 'noreply@mg.example.com',
        region: 'US',
      },
      {},
    );
    expect(domainCheck.statusCode).toBe(200);
    expect(fetchSpy.mock.calls[1]![0]).toBe('https://api.mailgun.net/v3/domains/mg.example.com');
    expect(fetchSpy.mock.calls[1]![1]?.method).toBe('GET');
  });

  it('rejects missing recipient/subject/body and classifies 429 vs 400 with apiKey redaction', async () => {
    const creds = {
      apiKey,
      domain: 'mg.example.com',
      from: 'noreply@mg.example.com',
      region: 'US' as const,
    };

    await expect(
      adapter.send({
        credentials: creds,
        content: { subject: 'Hi', body: '<p>Hi</p>' },
      }),
    ).rejects.toThrow(ProviderConfigurationError);

    await expect(
      adapter.send({
        credentials: creds,
        target: 'user@example.com',
        content: { body: '<p>Hi</p>' },
      }),
    ).rejects.toThrow(ProviderConfigurationError);

    await expect(
      adapter.send({
        credentials: creds,
        target: 'user@example.com',
        content: { subject: 'Hi', body: '   ' },
      }),
    ).rejects.toThrow(ProviderConfigurationError);

    // 429 rate limited -> retryable
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Too Many Requests', { status: 429 }),
    );
    await expect(
      adapter.send({
        credentials: creds,
        target: 'user@example.com',
        content: { subject: 'Hi', body: '<p>Hi</p>' },
      }),
    ).rejects.toMatchObject({
      retryable: true,
      statusCode: 429,
    });

    // Network failure leaking apiKey -> redacted
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error(`Socket error with ${apiKey}`));
    let caught: unknown;
    try {
      await adapter.send({
        credentials: { ...creds, baseUrl: 'https://custom.mailgun.local/' },
        target: 'user@example.com',
        content: { subject: 'Hi', body: '<p>Hi</p>' },
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderDeliveryError);
    expect((caught as ProviderDeliveryError).retryable).toBe(true);
    expect((caught as ProviderDeliveryError).message).not.toContain(apiKey);
    expect((caught as ProviderDeliveryError).message).toContain('[REDACTED]');
  });
});
