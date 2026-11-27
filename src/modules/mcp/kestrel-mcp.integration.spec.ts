import type { Client } from '@modelcontextprotocol/client';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { McpModule } from '@nestjs/mcp';
import { connectMcpClient } from '@nestjs/mcp/testing';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter.js';
import { ApiKeyGuard } from '../../common/guards/api-key.guard.js';
import { LoggingInterceptor } from '../../common/interceptors/logging.interceptor.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { RedisService } from '../../common/redis/redis.service.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { DeliveriesService } from '../deliveries/deliveries.service.js';
import { IngestionService } from '../events/ingestion.service.js';
import { InboundService } from '../inbound/inbound.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { RulesService } from '../rules/rules.service.js';
import { EventSchemasService } from '../schemas/event-schemas.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { KestrelMcpModule } from './kestrel-mcp.module.js';
import { MCP_RESOURCE_URIS, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './mcp.constants.js';
import { MCP_PRIMITIVE_PROVIDERS } from './mcp-primitives.module.js';

const EXPECTED_TOOLS = [
  'get_analytics_summary',
  'inspect_delivery',
  'list_deliveries',
  'replay_delivery',
  'send_event',
  'toggle_inbound_source',
];

interface TextToolResult {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

function firstText(result: unknown): string {
  const content = (result as TextToolResult).content;
  const block = content.find((item) => item.type === 'text');
  return block?.text ?? '';
}

function generateApiKey(): string {
  return `kmq_live_${randomBytes(24).toString('hex')}`;
}

describe('KestrelMcpModule (in-memory MCP client)', () => {
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const keyA = generateApiKey();
  const keyB = generateApiKey();
  const revokedKey = generateApiKey();

  const ingestEvent = vi.fn();
  const listDeliveries = vi.fn();
  const getDeliveryById = vi.fn();
  const replayDelivery = vi.fn();
  const getSummary = vi.fn();
  const pauseSource = vi.fn();
  const resumeSource = vi.fn();
  const listSchemas = vi.fn();
  const listTemplates = vi.fn();
  const listRules = vi.fn();
  const listIntegrations = vi.fn();

  let app: INestApplication;
  const clients: Client[] = [];

  async function connect(headers: Record<string, string> = {}): Promise<Client> {
    const client = await connectMcpClient(app, { headers });
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    const configService = {
      get: () => randomBytes(32).toString('hex'),
    } as unknown as ConfigService<EnvConfig, true>;
    const cryptoService = new CryptoService(configService);

    const keyRecords = new Map([
      [cryptoService.hashSha256(keyA), { id: randomUUID(), workspaceId: workspaceA, revokedAt: null }],
      [cryptoService.hashSha256(keyB), { id: randomUUID(), workspaceId: workspaceB, revokedAt: null }],
      [
        cryptoService.hashSha256(revokedKey),
        { id: randomUUID(), workspaceId: workspaceA, revokedAt: new Date() },
      ],
    ]);

    const prismaService = {
      apiKey: {
        findUnique: vi.fn(async ({ where }: { where: { keyHash: string } }) =>
          keyRecords.get(where.keyHash) ?? null,
        ),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const redisService = {
      get: vi.fn().mockResolvedValue(null),
      setEx: vi.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [McpModule.forRoot({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION })],
      providers: [
        ...MCP_PRIMITIVE_PROVIDERS,
        ApiKeyGuard,
        { provide: CryptoService, useValue: cryptoService },
        { provide: PrismaService, useValue: prismaService },
        { provide: RedisService, useValue: redisService },
        { provide: IngestionService, useValue: { ingestEvent } },
        { provide: DeliveriesService, useValue: { listDeliveries, getDeliveryById, replayDelivery } },
        { provide: AnalyticsService, useValue: { getSummary } },
        { provide: InboundService, useValue: { pauseSource, resumeSource } },
        { provide: EventSchemasService, useValue: { listSchemas } },
        { provide: TemplatesService, useValue: { listTemplates } },
        { provide: RulesService, useValue: { listRules } },
        { provide: IntegrationsService, useValue: { listIntegrations } },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
      ],
    }).compile();

    moduleRef.useLogger(false);
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ingestEvent.mockImplementation(async (workspaceId: string) => ({
      eventId: 'evt-1',
      workspaceId,
      deliveryIds: ['del-1'],
    }));
    listSchemas.mockImplementation(async (workspaceId: string) => [
      {
        eventName: `event.of.${workspaceId}`,
        validationMode: 'WARN',
        variables: [],
        jsonSchema: {},
        samplePayload: {},
      },
    ]);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await app.close();
  });

  it('advertises exactly the six tools and two resources', async () => {
    const client = await connect({ authorization: `Bearer ${keyA}` });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain('workspaceId');
    }

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      MCP_RESOURCE_URIS.schemas,
      MCP_RESOURCE_URIS.templates,
    ]);
  });

  it('scopes tool calls to the workspace of the API key', async () => {
    const clientA = await connect({ authorization: `Bearer ${keyA}` });
    const clientB = await connect({ 'x-api-key': keyB });

    const resultA = await clientA.callTool({
      name: 'send_event',
      arguments: { event: 'order.paid', payload: { orderId: 'ord_1' } },
    });
    const resultB = await clientB.callTool({
      name: 'send_event',
      arguments: { event: 'order.paid', payload: { orderId: 'ord_2' } },
    });

    expect(resultA.isError).toBeFalsy();
    expect(JSON.parse(firstText(resultA))).toMatchObject({ workspaceId: workspaceA });
    expect(JSON.parse(firstText(resultB))).toMatchObject({ workspaceId: workspaceB });
    expect(ingestEvent.mock.calls.map((call) => call[0])).toEqual([workspaceA, workspaceB]);
  });

  it('rejects a client-supplied workspaceId argument before any service runs', async () => {
    const client = await connect({ authorization: `Bearer ${keyA}` });

    const result = await client.callTool({
      name: 'send_event',
      arguments: { event: 'order.paid', payload: {}, workspaceId: workspaceB },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Input validation error');
    expect(ingestEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing key', {}],
    ['a revoked key', { authorization: `Bearer ${revokedKey}` }],
    ['a malformed key', { 'x-api-key': 'not_a_kestrel_key' }],
  ])('fails tool calls with %s', async (_label, headers: Record<string, string>) => {
    const client = await connect(headers);

    const result = await client.callTool({ name: 'get_analytics_summary', arguments: {} });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/API key/i);
    expect(getSummary).not.toHaveBeenCalled();
  });

  it('surfaces domain NotFoundException messages as tool errors (no cross-tenant leakage)', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    getDeliveryById.mockRejectedValue(new NotFoundException('Delivery not found'));
    const client = await connect({ authorization: `Bearer ${keyB}` });

    const result = await client.callTool({
      name: 'inspect_delivery',
      arguments: { deliveryId: randomUUID() },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe('Delivery not found');
    expect(getDeliveryById.mock.calls[0]?.[0]).toBe(workspaceB);
  });

  it('returns a generic error for unexpected failures without leaking internals', async () => {
    getSummary.mockRejectedValue(new Error('SELECT * FROM deliveries exploded'));
    const client = await connect({ authorization: `Bearer ${keyA}` });

    const result = await client.callTool({ name: 'get_analytics_summary', arguments: {} });

    expect(result.isError).toBe(true);
    expect(firstText(result)).not.toContain('SELECT');
  });

  it('scopes kestrelmq://schemas to the caller and drops sample payloads', async () => {
    const client = await connect({ authorization: `Bearer ${keyB}` });

    const { contents } = await client.readResource({ uri: MCP_RESOURCE_URIS.schemas });
    const body = contents[0] !== undefined && 'text' in contents[0] ? contents[0].text : '';

    expect(listSchemas).toHaveBeenCalledWith(workspaceB);
    expect(JSON.parse(body)).toEqual([
      { eventName: `event.of.${workspaceB}`, validationMode: 'WARN', variables: [], jsonSchema: {} },
    ]);
  });

  it('rejects resource reads without a valid key', async () => {
    const client = await connect();
    await expect(client.readResource({ uri: MCP_RESOURCE_URIS.templates })).rejects.toThrow();
    expect(listTemplates).not.toHaveBeenCalled();
  });
});

describe('Process separation', () => {
  function collectModuleGraph(root: Type<unknown>): Set<unknown> {
    const seen = new Set<unknown>();
    const visit = (entry: unknown): void => {
      if (entry === undefined || entry === null || seen.has(entry)) {
        return;
      }
      seen.add(entry);
      const moduleClass =
        typeof entry === 'function' ? entry : (entry as Partial<DynamicModule>).module;
      if (moduleClass !== undefined) {
        seen.add(moduleClass);
        const imports = (Reflect.getMetadata('imports', moduleClass) ?? []) as unknown[];
        imports.forEach(visit);
      }
      if (typeof entry !== 'function') {
        ((entry as Partial<DynamicModule>).imports ?? []).forEach(visit);
      }
    };
    visit(root);
    return seen;
  }

  it('never mounts the MCP server in the worker process', async () => {
    vi.stubEnv('POSTGRES_URL', 'postgresql://user:pass@localhost:5432/kestrelmq');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('APP_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('ENCRYPTION_MASTER_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('JWT_ACCESS_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('JWT_REFRESH_SECRET', randomBytes(32).toString('hex'));
    try {
      const [{ WorkerModule }, { AppModule }] = await Promise.all([
        import('../worker/worker.module.js'),
        import('../../app.module.js'),
      ]);

      const workerGraph = collectModuleGraph(WorkerModule);
      expect(workerGraph.has(McpModule)).toBe(false);
      expect(workerGraph.has(KestrelMcpModule)).toBe(false);

      expect(collectModuleGraph(AppModule).has(KestrelMcpModule)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
