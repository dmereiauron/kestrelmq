import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { IntegrationChannel, IntegrationProvider } from '../../generated/prisma/enums.js';
import { CreateRuleDto } from './dto/create-rule.dto.js';
import { UpdateRuleDto } from './dto/update-rule.dto.js';
import { RulesController } from './rules.controller.js';
import { RulesService } from './rules.service.js';

describe('RulesService & RulesController', () => {
  let ruleCreateMock: ReturnType<typeof vi.fn>;
  let ruleFindManyMock: ReturnType<typeof vi.fn>;
  let ruleFindFirstMock: ReturnType<typeof vi.fn>;
  let ruleUpdateMock: ReturnType<typeof vi.fn>;
  let ruleDeleteManyMock: ReturnType<typeof vi.fn>;
  let integrationFindFirstMock: ReturnType<typeof vi.fn>;
  let templateFindFirstMock: ReturnType<typeof vi.fn>;
  let service: RulesService;
  let controller: RulesController;

  beforeEach(() => {
    ruleCreateMock = vi.fn();
    ruleFindManyMock = vi.fn();
    ruleFindFirstMock = vi.fn();
    ruleUpdateMock = vi.fn();
    ruleDeleteManyMock = vi.fn();
    integrationFindFirstMock = vi.fn();
    templateFindFirstMock = vi.fn();

    const prismaService = {
      routingRule: {
        create: ruleCreateMock,
        findMany: ruleFindManyMock,
        findFirst: ruleFindFirstMock,
        update: ruleUpdateMock,
        deleteMany: ruleDeleteManyMock,
      },
      integration: {
        findFirst: integrationFindFirstMock,
      },
      template: {
        findFirst: templateFindFirstMock,
      },
    } as unknown as PrismaService;

    service = new RulesService(prismaService);
    controller = new RulesController(service);
  });

  it('enforces cross-tenant integration/template ownership on CRUD (POST, GET, PATCH, DELETE)', async () => {
    const workspaceId = randomUUID();
    const integrationId = randomUUID();
    const templateId = randomUUID();
    const ruleId = randomUUID();
    const now = new Date();

    // Whitespace eventName -> 400
    await expect(
      controller.createRule(workspaceId, {
        eventName: 'order paid',
        integrationId,
      }),
    ).rejects.toThrow(BadRequestException);

    // Integration from another workspace / missing -> 400
    integrationFindFirstMock.mockResolvedValueOnce(null);
    await expect(
      controller.createRule(workspaceId, {
        eventName: 'order.paid',
        integrationId,
      }),
    ).rejects.toThrow(BadRequestException);

    // Template from another workspace / missing -> 400
    integrationFindFirstMock.mockResolvedValueOnce({ id: integrationId });
    templateFindFirstMock.mockResolvedValueOnce(null);
    await expect(
      controller.createRule(workspaceId, {
        eventName: 'order.paid',
        integrationId,
        templateId,
      }),
    ).rejects.toThrow(BadRequestException);

    // Valid creation
    integrationFindFirstMock.mockResolvedValueOnce({ id: integrationId });
    templateFindFirstMock.mockResolvedValueOnce({ id: templateId });
    ruleCreateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: ruleId,
      ...data,
      createdAt: now,
    }));

    const created = await controller.createRule(workspaceId, {
      eventName: 'order.paid',
      integrationId,
      templateId,
      targetOverride: 'payload.customer.email',
    });
    expect(created.id).toBe(ruleId);
    expect(created.eventName).toBe('order.paid');

    // List with optional eventName filter
    ruleFindManyMock.mockResolvedValueOnce([created]);
    await expect(controller.listRules(workspaceId, 'order.paid')).resolves.toEqual([created]);

    // PATCH switching templateId to null (BYOT) and toggling isActive
    ruleFindFirstMock.mockResolvedValueOnce({ id: ruleId });
    ruleUpdateMock.mockResolvedValueOnce({
      ...created,
      templateId: null,
      targetOverride: null,
      isActive: false,
    });
    const patched = await controller.updateRule(workspaceId, ruleId, {
      templateId: null,
      targetOverride: null,
      isActive: false,
    });
    expect(patched.templateId).toBeNull();
    expect(patched.isActive).toBe(false);

    // PATCH missing rule -> 404
    ruleFindFirstMock.mockResolvedValueOnce(null);
    await expect(
      controller.updateRule(workspaceId, randomUUID(), { isActive: true }),
    ).rejects.toThrow(NotFoundException);

    // DELETE -> 204 & 404
    ruleDeleteManyMock.mockResolvedValueOnce({ count: 1 });
    await expect(controller.deleteRule(workspaceId, ruleId)).resolves.toBeUndefined();

    ruleDeleteManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(controller.deleteRule(workspaceId, randomUUID())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('matches exact, *, and prefix-wildcard events and queries active database rules', async () => {
    const workspaceId = randomUUID();
    const now = new Date();

    expect(service.matchesEventPattern('*', 'order.paid')).toBe(true);
    expect(service.matchesEventPattern('order.paid', 'order.paid')).toBe(true);
    expect(service.matchesEventPattern('order.*', 'order.paid')).toBe(true);
    expect(service.matchesEventPattern('order.*', 'order.')).toBe(false);
    expect(service.matchesEventPattern('order.shipped', 'order.paid')).toBe(false);

    ruleFindManyMock.mockResolvedValueOnce([
      {
        id: randomUUID(),
        workspaceId,
        eventName: '*',
        integrationId: randomUUID(),
        templateId: null,
        targetOverride: null,
        isActive: true,
        createdAt: now,
        integration: {
          id: randomUUID(),
          channel: IntegrationChannel.WEBHOOK,
          provider: IntegrationProvider.CUSTOM_WEBHOOK,
          isActive: true,
        },
        template: null,
      },
    ]);

    const dbMatches = await service.findMatchingRules(workspaceId, 'billing.invoice.paid');
    expect(dbMatches).toHaveLength(1);
    expect(ruleFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId,
          isActive: true,
          eventName: {
            in: expect.arrayContaining([
              '*',
              'billing.invoice.paid',
              'billing.*',
              'billing.invoice.*',
            ]),
          },
        }),
      }),
    );
  });

  it('evaluates JsonLogic conditions, resolves recipients dynamically, and blocks prototype pollution in JsonLogic ASTs', () => {
    const rules = [
      {
        id: 'rule-vip-email',
        eventName: 'order.paid',
        channel: IntegrationChannel.EMAIL,
        condition: {
          and: [
            { '>=': [{ var: 'payload.amount' }, 100] },
            { in: [{ var: 'payload.tier' }, ['PRO', 'ENTERPRISE']] },
          ],
        },
      },
      {
        id: 'rule-ops-telegram',
        eventName: '*',
        channel: IntegrationChannel.TELEGRAM,
        targetOverride: 'payload.ops.chatId',
        condition: null,
      },
      {
        id: 'rule-disabled',
        eventName: '*',
        channel: IntegrationChannel.WEBHOOK,
        isActive: false,
      },
      {
        id: 'rule-unmatched-condition',
        eventName: 'order.paid',
        channel: IntegrationChannel.SLACK,
        condition: { '==': [{ var: 'payload.currency' }, 'JPY'] },
      },
    ];

    const matches = service.evaluateRules(rules, {
      eventName: 'order.paid',
      payload: {
        amount: 250,
        tier: 'ENTERPRISE',
        currency: 'USD',
        customer: { email: 'vip@enterprise.io' },
        ops: { chatId: -100555777 },
      },
    });

    expect(matches).toEqual([
      {
        rule: rules[0],
        resolvedTarget: 'vip@enterprise.io',
      },
      {
        rule: rules[1],
        resolvedTarget: '-100555777',
      },
    ]);

    // Static targetOverride vs recipient envelope vs payload fallback across channels
    expect(
      service.resolveRecipientTarget({
        channel: IntegrationChannel.EMAIL,
        targetOverride: 'alerts@acme.io',
        recipient: { email: 'ignored@acme.io' },
        payload: {},
      }),
    ).toBe('alerts@acme.io');

    expect(
      service.resolveRecipientTarget({
        channel: IntegrationChannel.WEBHOOK,
        recipient: { webhookUrl: 'https://hooks.acme.io/r1' },
        payload: {},
      }),
    ).toBe('https://hooks.acme.io/r1');

    expect(
      service.resolveRecipientTarget({
        channel: IntegrationChannel.SLACK,
        recipient: { slackWebhookUrl: 'https://hooks.slack.com/services/T1/B1/X1' },
        payload: {},
      }),
    ).toBe('https://hooks.slack.com/services/T1/B1/X1');

    // Prototype pollution attempts in JsonLogic AST must throw 400 BadRequestException
    expect(() =>
      service.evaluateCondition({ '==': [{ var: '__proto__.polluted' }, true] }, {}),
    ).toThrow(BadRequestException);

    expect(() =>
      service.evaluateCondition({ '==': [{ var: ['constructor.prototype.isAdmin', false] }, true] }, {}),
    ).toThrow(BadRequestException);

    expect(() =>
      service.evaluateCondition({ missing: ['user.prototype'] }, {}),
    ).toThrow(BadRequestException);

    expect(() =>
      service.evaluateCondition({ missing_some: [1, ['__proto__']] }, {}),
    ).toThrow(BadRequestException);

    const parsedProtoAst = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    expect(() => service.evaluateCondition(parsedProtoAst, {})).toThrow(BadRequestException);
  });

  it('validates CreateRuleDto and UpdateRuleDto constraints', async () => {
    expect(
      await validate(
        plainToInstance(CreateRuleDto, {
          eventName: 'order.paid',
          integrationId: randomUUID(),
          templateId: randomUUID(),
        }),
      ),
    ).toHaveLength(0);

    expect(
      await validate(
        plainToInstance(UpdateRuleDto, {
          templateId: null,
          isActive: false,
        }),
      ),
    ).toHaveLength(0);
  });
});
