import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationsService } from '../../integrations/integrations.service.js';
import type { RulesService } from '../../rules/rules.service.js';
import type { EventSchemasService } from '../../schemas/event-schemas.service.js';
import type { TemplatesService } from '../../templates/templates.service.js';
import { createMcpCallFixture, createWorkspaceMcpContext } from '../testing/mcp-context.fixture.js';
import { WorkspaceResources } from './workspace.resources.js';

describe('WorkspaceResources', () => {
  let listSchemas: ReturnType<typeof vi.fn>;
  let listTemplates: ReturnType<typeof vi.fn>;
  let listRules: ReturnType<typeof vi.fn>;
  let listIntegrations: ReturnType<typeof vi.fn>;
  let resources: WorkspaceResources;

  beforeEach(() => {
    listSchemas = vi.fn().mockResolvedValue([
      {
        id: 'sch-1',
        workspaceId: 'ws-a',
        eventName: 'order.paid',
        samplePayload: { customer: { email: 'pii@example.com' } },
        jsonSchema: { type: 'object' },
        validationMode: 'STRICT',
        variables: ['customer.email'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    listTemplates = vi.fn().mockResolvedValue([
      {
        id: 'tpl-1',
        workspaceId: 'ws-a',
        name: 'Order paid',
        subjectTemplate: 'Order {{orderId}}',
        bodyTemplate: 'Hi {{customer.name}}{{#each items}}{{sku}}{{/each}}',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'tpl-2',
        workspaceId: 'ws-a',
        name: 'Unused',
        subjectTemplate: null,
        bodyTemplate: 'Static',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    listRules = vi.fn().mockResolvedValue([
      { id: 'rule-1', eventName: 'order.paid', integrationId: 'int-1', templateId: 'tpl-1', isActive: true },
      { id: 'rule-2', eventName: '*', integrationId: 'int-gone', templateId: 'tpl-1', isActive: false },
      { id: 'rule-3', eventName: 'byot', integrationId: 'int-1', templateId: null, isActive: true },
    ]);
    listIntegrations = vi.fn().mockResolvedValue([{ id: 'int-1', channel: 'EMAIL' }]);

    resources = new WorkspaceResources(
      { listSchemas } as unknown as EventSchemasService,
      { listTemplates } as unknown as TemplatesService,
      { listRules } as unknown as RulesService,
      { listIntegrations } as unknown as IntegrationsService,
    );
  });

  it('kestrelmq://schemas lists the workspace schemas without sample payloads', async () => {
    const result = await resources.schemas({}, createWorkspaceMcpContext('ws-a'));

    expect(listSchemas).toHaveBeenCalledWith('ws-a');
    expect(result).toEqual([
      {
        eventName: 'order.paid',
        validationMode: 'STRICT',
        variables: ['customer.email'],
        jsonSchema: { type: 'object' },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('pii@example.com');
  });

  it('kestrelmq://templates joins templates with their routing rules and channels', async () => {
    const result = await resources.templates({}, createWorkspaceMcpContext('ws-a'));

    expect(listTemplates).toHaveBeenCalledWith('ws-a');
    expect(listRules).toHaveBeenCalledWith('ws-a');
    expect(listIntegrations).toHaveBeenCalledWith('ws-a');
    expect(result).toEqual([
      {
        id: 'tpl-1',
        name: 'Order paid',
        subjectTemplate: 'Order {{orderId}}',
        variables: ['customer.name', 'items', 'orderId', 'sku'],
        routes: [
          { ruleId: 'rule-1', eventName: 'order.paid', integrationId: 'int-1', channel: 'EMAIL', isActive: true },
          { ruleId: 'rule-2', eventName: '*', integrationId: 'int-gone', channel: null, isActive: false },
        ],
      },
      { id: 'tpl-2', name: 'Unused', subjectTemplate: null, variables: [], routes: [] },
    ]);
  });

  it('advertises no variables for an unparsable stored template instead of failing', async () => {
    listTemplates.mockResolvedValue([
      {
        id: 'tpl-x',
        workspaceId: 'ws-a',
        name: 'Broken',
        subjectTemplate: null,
        bodyTemplate: '{{#if open}}',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const result = await resources.templates({}, createWorkspaceMcpContext('ws-a'));
    expect(result[0]?.variables).toEqual([]);
  });

  it('refuses to read without a verified workspace', async () => {
    await expect(resources.schemas({}, createMcpCallFixture().mcpContext)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(listSchemas).not.toHaveBeenCalled();
  });
});
