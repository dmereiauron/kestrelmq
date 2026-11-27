import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationChannel, IntegrationProvider } from '../../../generated/prisma/enums.js';
import {
  ProviderConfigurationError,
  ProviderDeliveryError,
} from '../errors/provider-delivery.error.js';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../interfaces/notification-provider.interface.js';
import { TelegramAdapter } from './telegram.adapter.js';

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let botToken: string;

  beforeEach(() => {
    adapter = new TelegramAdapter();
    botToken = `123456789:${randomBytes(18).toString('hex')}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls Telegram sendMessage with parse_mode HTML and 10s timeout', async () => {
    expect(adapter.provider).toBe(IntegrationProvider.TELEGRAM_BOT);
    expect(adapter.channel).toBe(IntegrationChannel.TELEGRAM);

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 }),
    );

    const result = await adapter.send({
      credentials: {
        botToken,
        defaultChatId: '-100999888',
      },
      content: {
        body: '<b>Order #1024</b> has been paid.',
      },
    });

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_PROVIDER_TIMEOUT_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe(`https://api.telegram.org/bot${botToken}/sendMessage`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: '-100999888',
      text: '<b>Order #1024</b> has been paid.',
      parse_mode: 'HTML',
    });

    expect(result.statusCode).toBe(200);
    expect(result.provider).toBe(IntegrationProvider.TELEGRAM_BOT);
  });

  it('supports testConnection via sendMessage when chatId is known and getMe when chatId is omitted', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"ok":true,"result":{"id":1}}', { status: 200 }));

    // With explicit target chatId -> POST /sendMessage
    const msgPing = await adapter.testConnection({ botToken }, { target: '777111' });
    expect(msgPing.statusCode).toBe(200);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`https://api.telegram.org/bot${botToken}/sendMessage`);

    // Without chatId -> GET /getMe
    const getMePing = await adapter.testConnection({ botToken }, {});
    expect(getMePing.statusCode).toBe(200);
    expect(fetchSpy.mock.calls[1]![0]).toBe(`https://api.telegram.org/bot${botToken}/getMe`);
    expect(fetchSpy.mock.calls[1]![1]?.method).toBe('GET');
  });

  it('validates missing chatId/body, classifies 4xx vs 429, and redacts botToken from thrown errors', async () => {
    await expect(
      adapter.send({
        credentials: { botToken },
        content: { body: 'Hello' },
      }),
    ).rejects.toThrow(ProviderConfigurationError);

    await expect(
      adapter.send({
        credentials: { botToken, defaultChatId: '123' },
        content: { body: '   ' },
      }),
    ).rejects.toThrow(ProviderConfigurationError);

    // 401 unauthorized -> fatal
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(`{"ok":false,"description":"Unauthorized ${botToken}"}`, { status: 401 }),
    );
    await expect(
      adapter.send({
        credentials: { botToken, defaultChatId: '123' },
        content: { body: 'Hi' },
      }),
    ).rejects.toMatchObject({
      retryable: false,
      statusCode: 401,
      responseBody: '{"ok":false,"description":"Unauthorized [REDACTED]"}',
    });

    // Network failure containing full Telegram bot URL -> redacts token
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error(`request to https://api.telegram.org/bot${botToken}/sendMessage failed`),
    );

    let thrown: unknown;
    try {
      await adapter.send({
        credentials: { botToken, defaultChatId: '123' },
        content: { body: 'Hi' },
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderDeliveryError);
    expect((thrown as ProviderDeliveryError).retryable).toBe(true);
    expect((thrown as ProviderDeliveryError).message).not.toContain(botToken);
    expect((thrown as ProviderDeliveryError).message).toContain('[REDACTED]');
  });
});
