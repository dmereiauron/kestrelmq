import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KestrelApiError, KestrelClient } from '../sdk/src/index.js';
import { IntegrationChannel } from '../src/generated/prisma/enums.js';
import type { AuthTokenResponse } from '../src/modules/auth/interfaces/jwt-payload.interface.js';
import type {
  InboundSourceResponse,
  ReceiveInboundWebhookResponse,
  ResumeInboundSourceResponse,
} from '../src/modules/inbound/inbound.service.js';
import type {
  IntegrationResponse,
  TestIntegrationResponse,
} from '../src/modules/integrations/integrations.service.js';
import type { RoutingRuleResponse } from '../src/modules/rules/rules.service.js';
import type { TemplateResponse } from '../src/modules/templates/templates.service.js';
import type {
  CreatedApiKeyResponse,
  CreatedWorkspaceResponse,
} from '../src/modules/workspaces/workspaces.service.js';
import { type E2eEnvironment, pollUntil, startE2eEnvironment } from './helpers/e2e-harness.js';

interface JsonHttpResult<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

async function httpJson<T>(
  baseUrl: string,
  path: string,
  options: {
    readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    readonly token?: string;
    readonly workspaceId?: string;
    readonly headers?: Record<string, string>;
    readonly json?: unknown;
    readonly rawBody?: string;
  } = {},
): Promise<JsonHttpResult<T>> {
  const headers: Record<string, string> = {
    Accept: 'application/json, application/problem+json',
    ...(options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.workspaceId !== undefined ? { 'X-Workspace-Id': options.workspaceId } : {}),
    ...(options.headers ?? {}),
  };

  let body: string | undefined = options.rawBody;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });

  const parsed =
    response.status === 204 ? (undefined as T) : ((await response.json()) as T);

  return {
    status: response.status,
    headers: response.headers,
    body: parsed,
  };
}

function computeExpectedKestrelSignature(
  timestampHeader: string,
  rawBody: string,
  signingSecret: string,
): string {
  const digest = createHmac('sha256', signingSecret)
    .update(`${timestampHeader}.${rawBody}`, 'utf8')
    .digest('hex');
  return `v1=${digest}`;
}

describe('KestrelMQ Stage 6 End-to-End Integration Suite (Testcontainers)', () => {
  let env: E2eEnvironment;

  let accessToken = '';
  let workspaceId = '';
  let webhookSigningSecret = '';
  let apiKey = '';
  let outboundIntegrationId = '';
  let orderTemplateId = '';
  let sdkClient: KestrelClient;

  beforeAll(async () => {
    env = await startE2eEnvironment({
      freeRateLimitMax: 15,
      backoffScaleFactor: 0.04,
    });
  });

  afterAll(async () => {
    if (env) {
      await env.stop();
    }
  });

  it('Flow 1: Auth registration/login -> Workspace -> API key -> Encrypted Integration + Handlebars Template + Routing Rule & OpenAPI /docs', async () => {
    // Verify Swagger UI (/docs) & OpenAPI JSON (/docs-json)
    const swaggerUiRes = await fetch(`${env.apiBaseUrl}/docs`);
    expect(swaggerUiRes.status).toBe(200);
    expect(swaggerUiRes.headers.get('content-type')).toContain('text/html');

    const openApiRes = await httpJson<{
      readonly openapi: string;
      readonly components: { readonly securitySchemes: Record<string, unknown> };
      readonly paths: Record<string, unknown>;
    }>(env.apiBaseUrl, '/docs-json');
    expect(openApiRes.status).toBe(200);
    expect(openApiRes.body.openapi).toMatch(/^3\./);
    expect(openApiRes.body.components.securitySchemes).toHaveProperty('bearerAuth');
    expect(openApiRes.body.components.securitySchemes).toHaveProperty('apiKey');
    expect(openApiRes.body.paths).toHaveProperty('/v1/events');

    // 1. Register user + login + refresh rotation
    const dynamicPassword = `Kestrel!${randomBytes(12).toString('hex')}`;
    const email = `ada-${randomBytes(4).toString('hex')}@kestrelmq.io`;

    const registerRes = await httpJson<AuthTokenResponse>(env.apiBaseUrl, '/v1/auth/register', {
      method: 'POST',
      json: {
        email,
        password: dynamicPassword,
        fullName: 'Ada Lovelace',
      },
    });
    expect(registerRes.status).toBe(201);
    expect(registerRes.body.user.email).toBe(email);

    const loginRes = await httpJson<AuthTokenResponse>(env.apiBaseUrl, '/v1/auth/login', {
      method: 'POST',
      json: {
        email,
        password: dynamicPassword,
      },
    });
    expect(loginRes.status).toBe(200);

    const refreshRes = await httpJson<AuthTokenResponse>(env.apiBaseUrl, '/v1/auth/refresh', {
      method: 'POST',
      token: loginRes.body.refreshToken,
      json: {},
    });
    expect(refreshRes.status).toBe(200);
    accessToken = refreshRes.body.accessToken;

    // 2. Create Workspace
    const workspaceRes = await httpJson<CreatedWorkspaceResponse>(
      env.apiBaseUrl,
      '/v1/workspaces',
      {
        method: 'POST',
        token: accessToken,
        json: {
          name: 'Acme E2E Workspace',
          slug: 'acme-e2e',
        },
      },
    );
    expect(workspaceRes.status).toBe(201);
    expect(workspaceRes.body.webhookSigningSecret).toMatch(/^whsec_/);
    workspaceId = workspaceRes.body.id;
    webhookSigningSecret = workspaceRes.body.webhookSigningSecret;

    // 3. Generate API Key
    const apiKeyRes = await httpJson<CreatedApiKeyResponse>(
      env.apiBaseUrl,
      `/v1/workspaces/${workspaceId}/api-keys`,
      {
        method: 'POST',
        token: accessToken,
        json: { name: 'E2E Primary Key' },
      },
    );
    expect(apiKeyRes.status).toBe(201);
    expect(apiKeyRes.body.apiKey).toMatch(/^kmq_live_/);
    apiKey = apiKeyRes.body.apiKey;

    sdkClient = new KestrelClient({
      baseUrl: env.apiBaseUrl,
      apiKey,
      timeoutMs: 10_000,
    });

    // 4. Create CUSTOM_WEBHOOK Integration & verify AES-256-GCM encryption + test ping
    const outboundUrl = env.sink.urlFor('/sink/outbound');
    const integrationRes = await httpJson<IntegrationResponse>(
      env.apiBaseUrl,
      '/v1/integrations',
      {
        method: 'POST',
        token: accessToken,
        workspaceId,
        json: {
          name: 'Outbound Sink Webhook',
          channel: 'WEBHOOK',
          provider: 'CUSTOM_WEBHOOK',
          credentials: {
            url: outboundUrl,
          },
        },
      },
    );
    expect(integrationRes.status).toBe(201);
    expect(integrationRes.body).not.toHaveProperty('encryptedCredentials');
    outboundIntegrationId = integrationRes.body.id;

    const storedIntegration = await env.prisma.integration.findUniqueOrThrow({
      where: { id: outboundIntegrationId },
    });
    expect(storedIntegration.encryptedCredentials).not.toContain(outboundUrl);
    expect(storedIntegration.iv.length).toBeGreaterThan(0);
    expect(storedIntegration.authTag.length).toBeGreaterThan(0);

    const testPingRes = await httpJson<TestIntegrationResponse>(
      env.apiBaseUrl,
      `/v1/integrations/${outboundIntegrationId}/test`,
      {
        method: 'POST',
        token: accessToken,
        workspaceId,
        json: {},
      },
    );
    expect(testPingRes.status).toBe(200);
    await env.sink.waitForRequests('/sink/outbound', 1);
    env.sink.clearRequests('/sink/outbound');

    // 5. Create Handlebars Template
    const templateRes = await httpJson<TemplateResponse>(env.apiBaseUrl, '/v1/templates', {
      method: 'POST',
      token: accessToken,
      workspaceId,
      json: {
        name: 'Order Paid Webhook Payload',
        bodyTemplate:
          '{ "orderId": "{{orderId}}", "customer": "{{customer.name}}", "amount": {{amount}} }',
      },
    });
    expect(templateRes.status).toBe(201);
    orderTemplateId = templateRes.body.id;

    // 6. Create Routing Rule & verify JsonLogic engine in DI container
    const ruleRes = await httpJson<RoutingRuleResponse>(env.apiBaseUrl, '/v1/rules', {
      method: 'POST',
      token: accessToken,
      workspaceId,
      json: {
        eventName: 'order.paid',
        integrationId: outboundIntegrationId,
        templateId: orderTemplateId,
      },
    });
    expect(ruleRes.status).toBe(201);
    expect(ruleRes.body.eventName).toBe('order.paid');

    const jsonLogicMatches = env.rulesService.evaluateRules(
      [
        {
          id: ruleRes.body.id,
          eventName: 'order.*',
          channel: IntegrationChannel.WEBHOOK,
          condition: {
            and: [
              { '>=': [{ var: 'payload.amount' }, 100] },
              { '==': [{ var: 'payload.tier' }, 'VIP'] },
            ],
          },
        },
      ],
      {
        eventName: 'order.paid',
        payload: { amount: 250, tier: 'VIP', webhookUrl: outboundUrl },
      },
    );
    expect(jsonLogicMatches).toHaveLength(1);
    expect(jsonLogicMatches[0]?.resolvedTarget).toBe(outboundUrl);
  });

  it('Flow 2: Outbound POST /v1/events (202) -> BullMQ worker delivery with verified X-KestrelMQ-Signature (v1=) -> DELIVERED + audit row + Idempotent replay (200)', async () => {
    env.sink.clearRequests('/sink/outbound');

    // Dispatch first request and verify HTTP 202 Accepted
    const rawFirstRes = await httpJson<{
      readonly eventId: string;
      readonly idempotentReplay: boolean;
      readonly deliveryIds: readonly string[];
    }>(env.apiBaseUrl, '/v1/events', {
      method: 'POST',
      token: apiKey,
      headers: {
        'Idempotency-Key': 'idem-order-101',
      },
      json: {
        event: 'order.paid',
        payload: {
          orderId: 'ord_101',
          amount: 299,
          customer: { name: 'Ada Lovelace' },
        },
      },
    });

    expect(rawFirstRes.status).toBe(202);
    expect(rawFirstRes.body.idempotentReplay).toBe(false);
    expect(rawFirstRes.body.deliveryIds).toHaveLength(1);
    const deliveryId = rawFirstRes.body.deliveryIds[0]!;

    // Wait for standalone WorkerModule to compile Handlebars template and POST to sink
    const received = await env.sink.waitForRequests('/sink/outbound', 1, 15_000);
    const webhookReq = received[0]!;
    expect(webhookReq.parsedJson).toEqual({
      orderId: 'ord_101',
      customer: 'Ada Lovelace',
      amount: 299,
    });

    // Verify X-KestrelMQ-Timestamp + X-KestrelMQ-Signature (v1=<hmac>)
    const tsHeader = webhookReq.headers['x-kestrelmq-timestamp'];
    const sigHeader = webhookReq.headers['x-kestrelmq-signature'];
    expect(typeof tsHeader).toBe('string');
    expect(typeof sigHeader).toBe('string');
    expect(sigHeader).toBe(
      computeExpectedKestrelSignature(tsHeader as string, webhookReq.rawBody, webhookSigningSecret),
    );

    // Poll delivery via @kestrelmq/sdk until DELIVERED with audit trail
    const detail = await pollUntil(
      () => sdkClient.deliveries.get(deliveryId),
      (d) => d.status === 'DELIVERED',
      { description: 'outbound delivery to reach DELIVERED' },
    );

    expect(detail.attemptCount).toBe(1);
    expect(detail.deliveredAt).not.toBeNull();
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]?.attemptNumber).toBe(1);
    expect(detail.attempts[0]?.responseStatus).toBe(200);

    // Replay identical event with same Idempotency-Key via both raw HTTP (assert 200 OK) & SDK
    const rawReplayRes = await httpJson<{
      readonly eventId: string;
      readonly idempotentReplay: boolean;
      readonly deliveryIds: readonly string[];
    }>(env.apiBaseUrl, '/v1/events', {
      method: 'POST',
      token: apiKey,
      headers: {
        'Idempotency-Key': 'idem-order-101',
      },
      json: {
        event: 'order.paid',
        payload: {
          orderId: 'ord_101',
          amount: 299,
          customer: { name: 'Ada Lovelace' },
        },
      },
    });

    expect(rawReplayRes.status).toBe(200);
    expect(rawReplayRes.body.idempotentReplay).toBe(true);
    expect(rawReplayRes.body.eventId).toBe(rawFirstRes.body.eventId);
    expect(rawReplayRes.body.deliveryIds).toEqual([deliveryId]);

    // Confirm zero duplicate webhook calls were dispatched
    expect(env.sink.getRequests('/sink/outbound')).toHaveLength(1);
  });

  it('Flow 3: Exponential backoff retry simulation on 500 failures -> RETRYING transition -> recovery on 200', async () => {
    // Program /sink/flaky: fail twice with 500, then succeed with 200
    env.sink.clearRequests('/sink/flaky');
    env.sink.enqueueResponses('/sink/flaky', [
      { statusCode: 500, body: JSON.stringify({ error: 'Upstream DB down #1' }) },
      { statusCode: 500, body: JSON.stringify({ error: 'Upstream DB down #2' }) },
      { statusCode: 200, body: JSON.stringify({ ok: true, recovered: true }) },
    ]);

    const flakyIntegrationRes = await httpJson<IntegrationResponse>(
      env.apiBaseUrl,
      '/v1/integrations',
      {
        method: 'POST',
        token: accessToken,
        workspaceId,
        json: {
          name: 'Flaky Billing Webhook',
          channel: 'WEBHOOK',
          provider: 'CUSTOM_WEBHOOK',
          credentials: {
            url: env.sink.urlFor('/sink/flaky'),
          },
        },
      },
    );
    expect(flakyIntegrationRes.status).toBe(201);

    const flakyRuleRes = await httpJson<RoutingRuleResponse>(env.apiBaseUrl, '/v1/rules', {
      method: 'POST',
      token: accessToken,
      workspaceId,
      json: {
        eventName: 'invoice.failed',
        integrationId: flakyIntegrationRes.body.id,
      },
    });
    expect(flakyRuleRes.status).toBe(201);

    const sent = await sdkClient.events.send({
      event: 'invoice.failed',
      payload: { invoiceId: 'inv_500_test', amount: 499 },
      idempotencyKey: 'idem-flaky-inv-1',
    });
    expect(sent.deliveryIds).toHaveLength(1);
    const flakyDeliveryId = sent.deliveryIds[0]!;

    // Wait for attempt #1 to hit /sink/flaky and verify intermediate RETRYING state in Postgres
    await env.sink.waitForRequests('/sink/flaky', 1, 10_000);
    const retryingSnapshot = await pollUntil(
      () => sdkClient.deliveries.get(flakyDeliveryId),
      (d) => d.status === 'RETRYING' && d.attemptCount >= 1,
      { timeoutMs: 5_000, intervalMs: 25, description: 'delivery to enter RETRYING state' },
    );
    expect(retryingSnapshot.status).toBe('RETRYING');
    expect(retryingSnapshot.nextRetryAt).not.toBeNull();
    expect(retryingSnapshot.attempts[0]?.responseStatus).toBe(500);

    // Wait for attempt #2 (500) and attempt #3 (200) via BullMQ exponential backoff
    const allFlakyRequests = await env.sink.waitForRequests('/sink/flaky', 3, 20_000);
    expect(allFlakyRequests).toHaveLength(3);

    const gap1To2Ms = allFlakyRequests[1]!.receivedAtMs - allFlakyRequests[0]!.receivedAtMs;
    const gap2To3Ms = allFlakyRequests[2]!.receivedAtMs - allFlakyRequests[1]!.receivedAtMs;
    // Backoff schedule scales 10s -> 60s (6x); even with ±10% jitter, gap2To3Ms >> gap1To2Ms
    expect(gap2To3Ms).toBeGreaterThan(gap1To2Ms * 2.5);

    const recovered = await pollUntil(
      () => sdkClient.deliveries.get(flakyDeliveryId),
      (d) => d.status === 'DELIVERED',
      { timeoutMs: 10_000, description: 'flaky delivery to recover to DELIVERED' },
    );
    expect(recovered.attemptCount).toBe(3);
    expect(recovered.nextRetryAt).toBeNull();
    expect(recovered.deliveredAt).not.toBeNull();
    expect(recovered.attempts.map((a) => a.responseStatus)).toEqual([500, 500, 200]);
  });

  it('Flow 4: Inbound webhook gateway (POST /v1/inbound/:sourceSlug) with HMAC verification, Pause buffering (PAUSED), and Resume flushing', async () => {
    env.sink.clearRequests('/sink/inbound');
    const stripeSigningSecret = `whsec_${randomBytes(24).toString('hex')}`;

    const createSourceRes = await httpJson<InboundSourceResponse>(
      env.apiBaseUrl,
      '/v1/inbound-sources',
      {
        method: 'POST',
        token: accessToken,
        workspaceId,
        json: {
          name: 'Stripe Inbound Gateway',
          sourceSlug: 'stripe-e2e-gateway',
          providerType: 'STRIPE',
          signingSecret: stripeSigningSecret,
          targetUrl: env.sink.urlFor('/sink/inbound'),
          maxRatePerSec: 10,
        },
      },
    );
    expect(createSourceRes.status).toBe(201);
    const sourceId = createSourceRes.body.id;

    // 1. Reject forged HMAC signature with 401 ProblemDetails
    const nowSec = Math.floor(Date.now() / 1_000);
    const forgedBody = JSON.stringify({ id: 'evt_forged', type: 'charge.succeeded' });
    const invalidRes = await httpJson<{ readonly status: number; readonly type: string }>(
      env.apiBaseUrl,
      '/v1/inbound/stripe-e2e-gateway',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': `t=${nowSec},v1=${'a'.repeat(64)}`,
        },
        rawBody: forgedBody,
      },
    );
    expect(invalidRes.status).toBe(401);
    expect(invalidRes.headers.get('content-type')).toContain('application/problem+json');

    // 2. Pause inbound source for zero-downtime deployment buffering
    const pauseRes = await httpJson<InboundSourceResponse>(
      env.apiBaseUrl,
      `/v1/inbound-sources/${sourceId}/pause`,
      {
        method: 'POST',
        token: accessToken,
        workspaceId,
      },
    );
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.isPaused).toBe(true);

    // 3. Send 3 validly signed Stripe webhooks while paused
    const bufferedDeliveryIds: string[] = [];
    for (let idx = 1; idx <= 3; idx += 1) {
      const rawWebhook = JSON.stringify({
        id: `evt_stripe_${idx}`,
        type: 'payment_intent.succeeded',
        seq: idx,
      });
      const ts = Math.floor(Date.now() / 1_000);
      const hmac = createHmac('sha256', stripeSigningSecret)
        .update(`${ts}.${rawWebhook}`, 'utf8')
        .digest('hex');

      const inboundRes = await httpJson<ReceiveInboundWebhookResponse>(
        env.apiBaseUrl,
        '/v1/inbound/stripe-e2e-gateway',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': `t=${ts},v1=${hmac}`,
          },
          rawBody: rawWebhook,
        },
      );

      expect(inboundRes.status).toBe(200);
      expect(inboundRes.body.received).toBe(true);
      expect(inboundRes.body.status).toBe('PAUSED');
      expect(inboundRes.body.buffered).toBe(true);
      bufferedDeliveryIds.push(inboundRes.body.deliveryId);
    }

    // Verify zero webhooks leaked to downstream targetUrl while paused
    expect(env.sink.getRequests('/sink/inbound')).toHaveLength(0);
    const pausedDetail = await sdkClient.deliveries.get(bufferedDeliveryIds[0]!);
    expect(pausedDetail.status).toBe('PAUSED');

    // 4. Resume inbound source and verify worker drains all 3 buffered webhooks
    const resumeRes = await httpJson<ResumeInboundSourceResponse>(
      env.apiBaseUrl,
      `/v1/inbound-sources/${sourceId}/resume`,
      {
        method: 'POST',
        token: accessToken,
        workspaceId,
      },
    );
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.source.isPaused).toBe(false);
    expect(resumeRes.body.resumedDeliveriesCount).toBe(3);

    const forwarded = await env.sink.waitForRequests('/sink/inbound', 3, 15_000);
    expect(forwarded).toHaveLength(3);

    for (const deliveryId of bufferedDeliveryIds) {
      const drained = await pollUntil(
        () => sdkClient.deliveries.get(deliveryId),
        (d) => d.status === 'DELIVERED',
        { description: `buffered inbound delivery ${deliveryId} to drain` },
      );
      expect(drained.status).toBe('DELIVERED');
    }
  });

  it('Flow 5: Streaming CSV bulk import, Cancel & Replay, Cursor pagination, Analytics Cache-Aside, and 429 Sliding-Window Rate Limiting', async () => {
    env.sink.clearRequests('/sink/outbound');

    // 1. Streaming CSV bulk upload (5 rows: 3 immediate + 1 duplicate idempotency_key + 1 future scheduled)
    const futureDeliverAt = new Date(Date.now() + 3_600_000).toISOString();
    const csvLines = [
      'event_name,payload,idempotency_key,deliver_at',
      'order.paid,"{""orderId"":""csv_1"",""amount"":110,""customer"":{""name"":""Grace""}}",idem_csv_1,',
      'order.paid,"{""orderId"":""csv_1_dup"",""amount"":110,""customer"":{""name"":""Grace""}}",idem_csv_1,',
      'order.paid,"{""orderId"":""csv_2"",""amount"":220,""customer"":{""name"":""Alan""}}",idem_csv_2,',
      'order.paid,"{""orderId"":""csv_3"",""amount"":330,""customer"":{""name"":""Edsger""}}",idem_csv_3,',
      `order.paid,"{""orderId"":""csv_future"",""amount"":440,""customer"":{""name"":""Barbara""}}",idem_csv_future,${futureDeliverAt}`,
    ];
    const csvBuffer = Buffer.from(csvLines.join('\n'), 'utf8');

    const bulkResult = await sdkClient.events.sendBulk(csvBuffer, { filename: 'orders.csv' });
    expect(bulkResult).toEqual({
      totalRows: 5,
      importedEvents: 4,
      createdDeliveries: 4,
      skippedDuplicates: 1,
      failedRows: 0,
      errors: [],
    });

    // Wait for the 3 immediate CSV deliveries to arrive at /sink/outbound
    await env.sink.waitForRequests('/sink/outbound', 3, 15_000);

    // 2. Locate the SCHEDULED delivery, Cancel it, and then Replay it for immediate execution
    const scheduledList = await sdkClient.deliveries.list({ status: 'SCHEDULED', limit: 10 });
    expect(scheduledList.data).toHaveLength(1);
    const scheduledDeliveryId = scheduledList.data[0]!.id;

    const cancelRes = await sdkClient.deliveries.cancel(scheduledDeliveryId);
    expect(cancelRes.status).toBe('CANCELED');
    expect(cancelRes.canceled).toBe(true);

    const afterCancel = await sdkClient.deliveries.get(scheduledDeliveryId);
    expect(afterCancel.status).toBe('CANCELED');

    const replayRes = await sdkClient.deliveries.replay(scheduledDeliveryId);
    expect(replayRes.status).toBe('PENDING');
    expect(replayRes.replayed).toBe(true);

    await env.sink.waitForRequests('/sink/outbound', 4, 15_000);
    const afterReplay = await pollUntil(
      () => sdkClient.deliveries.get(scheduledDeliveryId),
      (d) => d.status === 'DELIVERED',
      { description: 'replayed delivery to reach DELIVERED' },
    );
    expect(afterReplay.attemptCount).toBe(1);

    // Ensure all 9 deliveries across Flows 2–5 have settled as DELIVERED before analytics & pagination checks
    await pollUntil(
      () => sdkClient.deliveries.list({ limit: 50 }),
      (page) => page.data.length === 9 && page.data.every((item) => item.status === 'DELIVERED'),
      { description: 'all 9 workspace deliveries to settle as DELIVERED' },
    );

    // 3. Keyset cursor pagination across pages of limit=3
    const collectedIds: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;

    do {
      const page = await sdkClient.deliveries.list({ limit: 3, cursor });
      pageCount += 1;
      for (const item of page.data) {
        collectedIds.push(item.id);
      }
      cursor = page.hasMore && page.nextCursor !== null ? page.nextCursor : undefined;
    } while (cursor !== undefined);

    expect(pageCount).toBe(3);
    expect(collectedIds).toHaveLength(9);
    expect(new Set(collectedIds).size).toBe(9);

    // 4. Analytics summary Cache-Aside behavior (miss -> cached hit)
    const freshSummary = await sdkClient.analytics.summary('24h');
    expect(freshSummary.cached).toBe(false);
    expect(freshSummary.totalEvents).toBe(9);
    expect(freshSummary.totalDeliveries).toBe(9);
    expect(freshSummary.deliveriesByStatus.DELIVERED).toBe(9);
    expect(freshSummary.successRate).toBe(100);
    expect(freshSummary.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(freshSummary.p95DurationMs).toBeGreaterThanOrEqual(0);

    const cachedSummary = await sdkClient.analytics.summary('24h');
    expect(cachedSummary.cached).toBe(true);
    expect(cachedSummary.totalDeliveries).toBe(9);

    // 5. Sliding-window 429 rate limiting on FREE workspace quota (RATE_LIMIT_FREE_MAX = 15)
    let rateLimitError: KestrelApiError | null = null;
    for (let i = 0; i < 20; i += 1) {
      try {
        await sdkClient.events.send({
          event: 'quota.probe',
          payload: { attempt: i },
        });
      } catch (err: unknown) {
        if (err instanceof KestrelApiError && err.status === 429) {
          rateLimitError = err;
          break;
        }
        throw err;
      }
    }

    expect(rateLimitError).not.toBeNull();
    expect(rateLimitError?.status).toBe(429);
    expect(rateLimitError?.type).toBe('https://errors.kestrelmq.io/too-many-requests');
    expect(rateLimitError?.retryAfterSec).not.toBeNull();
    expect(rateLimitError?.retryAfterSec).toBeGreaterThanOrEqual(1);

    // Verify raw HTTP rate-limit headers directly
    const raw429 = await httpJson<{ readonly status: number }>(env.apiBaseUrl, '/v1/events', {
      method: 'POST',
      token: apiKey,
      json: { event: 'quota.probe.raw', payload: {} },
    });
    expect(raw429.status).toBe(429);
    expect(raw429.headers.get('x-ratelimit-limit')).toBe('15');
    expect(raw429.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(Number(raw429.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
});
