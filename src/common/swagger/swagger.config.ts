import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import {
  SWAGGER_API_KEY_AUTH,
  SWAGGER_BEARER_AUTH,
} from './api-workspace-header.decorator.js';
import { ProblemDetailsDto } from './problem-details.dto.js';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('KestrelMQ API')
    .setDescription(
      'Self-hosted, multi-tenant notification orchestration, guaranteed outbound delivery, and buffered inbound webhook gateway.',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'User Access JWT (`Authorization: Bearer <jwt>`) or Workspace API Key (`Authorization: Bearer kmq_live_...`)',
      },
      SWAGGER_BEARER_AUTH,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description:
          'Workspace ingestion & SDK API key (`kmq_live_...`). Also accepted via `Authorization: Bearer kmq_live_...`.',
      },
      SWAGGER_API_KEY_AUTH,
    )
    .addGlobalParameters({
      name: 'x-workspace-id',
      in: 'header',
      required: false,
      description:
        'Workspace UUID context for user JWT requests (resolved automatically when authenticating via `kmq_live_...` API key).',
      schema: {
        type: 'string',
        format: 'uuid',
      },
    })
    .addTag('Auth', 'User registration, login, and Redis-backed JWT refresh rotation')
    .addTag('Workspaces', 'Multi-tenant workspaces, RBAC members, and API key provisioning')
    .addTag('Integrations', 'Encrypted external provider connections and connectivity tests')
    .addTag('Templates', 'Handlebars notification templates')
    .addTag('Rules', 'Wildcard and conditional event-to-channel routing rules')
    .addTag('Event Schemas', 'Sample-to-Schema JSON Schema inference and Ajv validation')
    .addTag('Events', 'Idempotent single-event ingestion and streaming CSV bulk import')
    .addTag('Deliveries', 'Keyset-paginated delivery logs, attempt audits, replay, and cancel')
    .addTag('Analytics', 'Cache-Aside workspace delivery metrics and latency percentiles')
    .addTag('Inbound Sources', 'Buffered inbound webhook endpoints and Pause/Resume controls')
    .addTag('Inbound Gateway', 'Public HMAC-verified inbound webhook receiver')
    .build();

  return SwaggerModule.createDocument(app, config, {
    extraModels: [ProblemDetailsDto],
  });
}

export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);

  SwaggerModule.setup('docs', app, document, {
    useGlobalPrefix: false,
    jsonDocumentUrl: 'docs-json',
    customSiteTitle: 'KestrelMQ OpenAPI Docs',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  return document;
}
