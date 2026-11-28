import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { setupSwagger } from './common/swagger/swagger.config.js';
import type { EnvConfig } from './config/env.validation.js';
import { MCP_HTTP_PATH } from './modules/mcp/mcp.constants.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const configService = app.get<ConfigService<EnvConfig, true>>(ConfigService);
  const rawCorsOrigins = configService.get('CORS_ORIGINS', { infer: true });
  const corsOrigins = rawCorsOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.enableCors({
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
    ],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
      'X-Request-Id',
    ],
  });

  app.enableShutdownHooks();
  app.setGlobalPrefix('v1', { exclude: [MCP_HTTP_PATH] });
  setupSwagger(app);

  const port = configService.get('PORT', { infer: true });

  await app.listen(port);
}

void bootstrap();
