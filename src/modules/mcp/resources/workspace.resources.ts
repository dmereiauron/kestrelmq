import { Injectable, UseGuards } from '@nestjs/common';
import { Resource } from '@nestjs/mcp';
import { ApiKeyGuard } from '../../../common/guards/api-key.guard.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import type {
  IntegrationChannel,
  SchemaValidationMode,
} from '../../../generated/prisma/enums.js';
import { IntegrationsService } from '../../integrations/integrations.service.js';
import { RulesService } from '../../rules/rules.service.js';
import { EventSchemasService } from '../../schemas/event-schemas.service.js';
import { TemplatesService } from '../../templates/templates.service.js';
import { extractTemplateVariables } from '../../templates/utils/extract-template-variables.util.js';
import { MCP_RESOURCE_URIS } from '../mcp.constants.js';
import { type KestrelMcpContext, resolveMcpWorkspaceId } from '../mcp-workspace.util.js';

export interface McpEventSchemaEntry {
  readonly eventName: string;
  readonly validationMode: SchemaValidationMode;
  readonly variables: readonly string[];
  readonly jsonSchema: Prisma.JsonValue;
}

export interface McpTemplateRoute {
  readonly ruleId: string;
  readonly eventName: string;
  readonly integrationId: string;
  readonly channel: IntegrationChannel | null;
  readonly isActive: boolean;
}

export interface McpTemplateEntry {
  readonly id: string;
  readonly name: string;
  readonly subjectTemplate: string | null;
  readonly variables: readonly string[];
  readonly routes: readonly McpTemplateRoute[];
}

function safeTemplateVariables(...sources: readonly (string | null)[]): string[] {
  const variables = new Set<string>();
  for (const source of sources) {
    if (source === null || source.length === 0) {
      continue;
    }
    try {
      for (const variable of extractTemplateVariables(source)) {
        variables.add(variable);
      }
    } catch {
      // Stored templates are validated on write; an unparsable one simply advertises no variables.
    }
  }
  return [...variables].sort((a, b) => a.localeCompare(b));
}

@Injectable()
@UseGuards(ApiKeyGuard)
export class WorkspaceResources {
  readonly #eventSchemasService: EventSchemasService;
  readonly #templatesService: TemplatesService;
  readonly #rulesService: RulesService;
  readonly #integrationsService: IntegrationsService;

  constructor(
    eventSchemasService: EventSchemasService,
    templatesService: TemplatesService,
    rulesService: RulesService,
    integrationsService: IntegrationsService,
  ) {
    this.#eventSchemasService = eventSchemasService;
    this.#templatesService = templatesService;
    this.#rulesService = rulesService;
    this.#integrationsService = integrationsService;
  }

  @Resource({
    uri: MCP_RESOURCE_URIS.schemas,
    name: 'event_schemas',
    title: 'Event schemas',
    description:
      'Registered event names of the authenticated workspace with their validation mode (DISABLED, WARN, ' +
      'STRICT), extracted dot-path payload variables and JSON Schema. Read before calling send_event.',
    mimeType: 'application/json',
  })
  async schemas(_input: Record<string, never>, ctx: KestrelMcpContext): Promise<McpEventSchemaEntry[]> {
    const workspaceId = resolveMcpWorkspaceId(ctx);
    const schemas = await this.#eventSchemasService.listSchemas(workspaceId);
    return schemas.map((schema) => ({
      eventName: schema.eventName,
      validationMode: schema.validationMode,
      variables: schema.variables,
      jsonSchema: schema.jsonSchema,
    }));
  }

  @Resource({
    uri: MCP_RESOURCE_URIS.templates,
    name: 'templates',
    title: 'Notification templates',
    description:
      'Notification templates of the authenticated workspace with their subject, Handlebars variable ' +
      'placeholders, and the routing rules (event name and channel) that use them.',
    mimeType: 'application/json',
  })
  async templates(_input: Record<string, never>, ctx: KestrelMcpContext): Promise<McpTemplateEntry[]> {
    const workspaceId = resolveMcpWorkspaceId(ctx);
    const [templates, rules, integrations] = await Promise.all([
      this.#templatesService.listTemplates(workspaceId),
      this.#rulesService.listRules(workspaceId),
      this.#integrationsService.listIntegrations(workspaceId),
    ]);

    const channelByIntegrationId = new Map<string, IntegrationChannel>(
      integrations.map((integration) => [integration.id, integration.channel]),
    );

    const routesByTemplateId = new Map<string, McpTemplateRoute[]>();
    for (const rule of rules) {
      if (rule.templateId === null) {
        continue;
      }
      const routes = routesByTemplateId.get(rule.templateId) ?? [];
      routes.push({
        ruleId: rule.id,
        eventName: rule.eventName,
        integrationId: rule.integrationId,
        channel: channelByIntegrationId.get(rule.integrationId) ?? null,
        isActive: rule.isActive,
      });
      routesByTemplateId.set(rule.templateId, routes);
    }

    return templates.map((template) => ({
      id: template.id,
      name: template.name,
      subjectTemplate: template.subjectTemplate,
      variables: safeTemplateVariables(template.subjectTemplate, template.bodyTemplate),
      routes: routesByTemplateId.get(template.id) ?? [],
    }));
  }
}
