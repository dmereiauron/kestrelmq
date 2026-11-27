import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { MCP_HTTP_PATH } from '../../src/modules/mcp/mcp.constants.js';
import type { RulesService } from '../../src/modules/rules/rules.service.js';
import { LocalWebhookSink } from './webhook-sink.js';

export interface E2eEnvironment {
  readonly app: NestExpressApplication;
  readonly workerContext: INestApplicationContext;
  readonly prisma: PrismaService;
  readonly rulesService: RulesService;
  readonly sink: LocalWebhookSink;
  readonly apiBaseUrl: string;
  readonly postgresContainer: StartedPostgreSqlContainer;
  readonly redisContainer: StartedRedisContainer;
  stop(): Promise<void>;
}

export async function startE2eEnvironment(options?: {
  readonly freeRateLimitMax?: number;
  readonly backoffScaleFactor?: number;
}): Promise<E2eEnvironment> {
  const ephemeralDbPassword = randomBytes(16).toString('hex');

  const [postgresContainer, redisContainer, sink] = await Promise.all([
    new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('kestrelmq_e2e')
      .withUsername('kestrelmq_e2e')
      .withPassword(ephemeralDbPassword)
      .start(),
    new RedisContainer('redis:8.2-alpine').start(),
    LocalWebhookSink.start(),
  ]);

  const postgresUrl = postgresContainer.getConnectionUri();
  const redisUrl = redisContainer.getConnectionUrl();

  process.env['NODE_ENV'] = 'test';
  process.env['PORT'] = '3000';
  process.env['POSTGRES_URL'] = postgresUrl;
  process.env['REDIS_URL'] = redisUrl;
  process.env['APP_SECRET'] = randomBytes(32).toString('hex');
  process.env['ENCRYPTION_MASTER_KEY'] = randomBytes(32).toString('hex');
  process.env['JWT_ACCESS_SECRET'] = randomBytes(32).toString('hex');
  process.env['JWT_REFRESH_SECRET'] = randomBytes(32).toString('hex');
  process.env['JWT_ACCESS_TTL_SEC'] = '900';
  process.env['JWT_REFRESH_TTL_SEC'] = '604800';
  process.env['RATE_LIMIT_WINDOW_MS'] = '60000';
  process.env['RATE_LIMIT_FREE_MAX'] = String(options?.freeRateLimitMax ?? 15);
  process.env['RATE_LIMIT_PRO_MAX'] = '600';
  process.env['RATE_LIMIT_ENTERPRISE_MAX'] = '3000';
  process.env['BACKOFF_SCALE_FACTOR'] = String(options?.backoffScaleFactor ?? 0.04);

  const projectRoot = resolve(import.meta.dirname, '../..');
  const prismaCliBin = resolve(projectRoot, 'node_modules/.bin/prisma');
  execFileSync(prismaCliBin, ['migrate', 'deploy'], {
    cwd: projectRoot,
    env: { ...process.env },
    stdio: 'pipe',
  });

  // Dynamically import NestJS modules AFTER process.env points to ephemeral Testcontainers
  const [
    { AppModule },
    { WorkerModule },
    { PrismaService: PrismaServiceToken },
    { RulesService: RulesServiceToken },
    { setupSwagger },
  ] = await Promise.all([
    import('../../src/app.module.js'),
    import('../../src/modules/worker/worker.module.js'),
    import('../../src/common/prisma/prisma.service.js'),
    import('../../src/modules/rules/rules.service.js'),
    import('../../src/common/swagger/swagger.config.js'),
  ]);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();
  app.setGlobalPrefix('v1', { exclude: [MCP_HTTP_PATH] });
  setupSwagger(app);
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;

  const workerContext = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn'],
  });
  workerContext.enableShutdownHooks();

  const prisma = app.get(PrismaServiceToken);
  const rulesService = app.get(RulesServiceToken);

  return {
    app,
    workerContext,
    prisma,
    rulesService,
    sink,
    apiBaseUrl,
    postgresContainer,
    redisContainer,
    async stop(): Promise<void> {
      await sink.close();
      await workerContext.close();
      await app.close();
      await Promise.all([redisContainer.stop(), postgresContainer.stop()]);
    },
  };
}

export async function pollUntil<T>(
  producer: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly description?: string;
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await producer();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${options.description ?? 'condition'}. Last value: ${JSON.stringify(lastValue)}`,
  );
}
