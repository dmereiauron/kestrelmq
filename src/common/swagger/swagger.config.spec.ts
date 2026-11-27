import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import {
  SWAGGER_API_KEY_AUTH,
  SWAGGER_BEARER_AUTH,
} from './api-workspace-header.decorator.js';
import { setupSwagger } from './swagger.config.js';

@ApiTags('Events')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@ApiSecurity(SWAGGER_API_KEY_AUTH)
@Controller('probe')
class SwaggerProbeController {
  @Get()
  ping(): { readonly ok: boolean } {
    return { ok: true };
  }
}

@Module({
  controllers: [SwaggerProbeController],
})
class SwaggerProbeModule {}

describe('setupSwagger & buildOpenApiDocument', () => {
  it('generates OpenAPI 3.0 document with bearerAuth, apiKey, x-workspace-id global header, tags, and ProblemDetailsDto', async () => {
    const app = await NestFactory.create(SwaggerProbeModule, { logger: false });
    app.setGlobalPrefix('v1');

    const document = setupSwagger(app);

    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBe('KestrelMQ API');
    expect(document.components?.securitySchemes).toHaveProperty(SWAGGER_BEARER_AUTH);
    expect(document.components?.securitySchemes).toHaveProperty(SWAGGER_API_KEY_AUTH);
    expect(document.components?.schemas).toHaveProperty('ProblemDetailsDto');
    expect(document.paths).toHaveProperty('/v1/probe');

    const probeGet = document.paths['/v1/probe']?.get;
    expect(probeGet?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'x-workspace-id',
          in: 'header',
        }),
      ]),
    );

    await app.close();
  });
});
