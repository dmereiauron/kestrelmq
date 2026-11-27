import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/guards/api-key.guard.js';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { EventsModule } from '../events/events.module.js';
import { InboundModule } from '../inbound/inbound.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { RulesModule } from '../rules/rules.module.js';
import { EventSchemasModule } from '../schemas/event-schemas.module.js';
import { TemplatesModule } from '../templates/templates.module.js';
import { WorkspaceResources } from './resources/workspace.resources.js';
import { AnalyticsTools } from './tools/analytics.tools.js';
import { DeliveryTools } from './tools/delivery.tools.js';
import { EventTools } from './tools/event.tools.js';
import { InboundTools } from './tools/inbound.tools.js';

export const MCP_PRIMITIVE_PROVIDERS = [
  EventTools,
  DeliveryTools,
  AnalyticsTools,
  InboundTools,
  WorkspaceResources,
] as const;

/**
 * The MCP tools and resources. They hold no logic of their own: each delegates to an existing, workspace-scoped
 * domain service. `McpModule` only discovers primitives in this module (`include`).
 */
@Module({
  imports: [
    EventsModule,
    DeliveriesModule,
    AnalyticsModule,
    InboundModule,
    EventSchemasModule,
    TemplatesModule,
    RulesModule,
    IntegrationsModule,
  ],
  providers: [ApiKeyGuard, RateLimitGuard, ...MCP_PRIMITIVE_PROVIDERS],
})
export class McpPrimitivesModule {}
