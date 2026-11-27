import { Module, UseGuards } from '@nestjs/common';
import { McpModule } from '@nestjs/mcp';
import { ApiExcludeController } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards/api-key.guard.js';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { MCP_HTTP_PATH, MCP_RESOURCE_URIS, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './mcp.constants.js';
import { McpPrimitivesModule } from './mcp-primitives.module.js';

export const MCP_SERVER_INSTRUCTIONS =
  'KestrelMQ is a multi-tenant notification orchestration and guaranteed webhook delivery platform. Every tool and ' +
  'resource is scoped to the workspace of the API key used to connect. Before send_event, read ' +
  `${MCP_RESOURCE_URIS.schemas} for the payload contract and ${MCP_RESOURCE_URIS.templates} for template variables. ` +
  'Deliveries are processed asynchronously: use list_deliveries and inspect_delivery to follow them, and ' +
  'replay_delivery for FAILED ones.';

/**
 * The official NestJS MCP server over stateless Streamable HTTP at `/mcp` (outside the `v1` prefix).
 *
 * Mounted by `AppModule` (`src/main.ts`) only, never by `WorkerModule` (`src/worker.ts`). Every HTTP request to the
 * endpoint passes `ApiKeyGuard` (401 problem+json without a valid `kmq_live_...` key) and the workspace
 * `RateLimitGuard`; each tool/resource call is checked again by `ApiKeyGuard` at call level.
 */
@Module({
  imports: [
    McpModule.forRoot({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      title: 'KestrelMQ',
      instructions: MCP_SERVER_INSTRUCTIONS,
      path: MCP_HTTP_PATH,
      include: [McpPrimitivesModule],
      decorators: [UseGuards(ApiKeyGuard, RateLimitGuard), ApiExcludeController()],
    }),
    McpPrimitivesModule,
  ],
})
export class KestrelMcpModule {}
