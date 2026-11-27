import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { getByPath } from '../../common/utils/get-by-path.util.js';
import { IntegrationChannel, type IntegrationProvider } from '../../generated/prisma/enums.js';
import type { CreateRuleDto } from './dto/create-rule.dto.js';
import type { UpdateRuleDto } from './dto/update-rule.dto.js';
import {
  evaluateJsonLogicCondition,
  type JsonLogicCondition,
} from './utils/json-logic.util.js';

export interface RoutingRuleResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventName: string;
  readonly integrationId: string;
  readonly templateId: string | null;
  readonly targetOverride: string | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
}

export interface MatchedRoutingRuleRecord extends RoutingRuleResponse {
  readonly integration: {
    readonly id: string;
    readonly channel: IntegrationChannel;
    readonly provider: IntegrationProvider;
    readonly isActive: boolean;
  };
  readonly template: {
    readonly id: string;
    readonly name: string;
    readonly subjectTemplate: string | null;
    readonly bodyTemplate: string;
  } | null;
}

export interface EvaluableRule {
  readonly id: string;
  readonly eventName: string;
  readonly channel: IntegrationChannel;
  readonly targetOverride?: string | null;
  readonly isActive?: boolean;
  readonly condition?: JsonLogicCondition | null;
}

export interface RuleEvaluationContext {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly recipient?: Record<string, unknown>;
}

export interface EvaluatedRuleMatch<TRule extends EvaluableRule = EvaluableRule> {
  readonly rule: TRule;
  readonly resolvedTarget: string | undefined;
}

export interface ResolveRecipientTargetInput {
  readonly channel: IntegrationChannel;
  readonly targetOverride?: string | null;
  readonly recipient?: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

const CHANNEL_PAYLOAD_FALLBACK_PATHS: Readonly<Record<IntegrationChannel, readonly string[]>> = {
  [IntegrationChannel.EMAIL]: ['email', 'user.email', 'customer.email', 'recipient.email'],
  [IntegrationChannel.TELEGRAM]: [
    'telegramChatId',
    'user.telegramChatId',
    'customer.telegramChatId',
    'chatId',
  ],
  [IntegrationChannel.WEBHOOK]: ['webhookUrl', 'targetUrl', 'callbackUrl'],
  [IntegrationChannel.SLACK]: ['slackWebhookUrl', 'webhookUrl'],
};

function coerceTargetValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeEventPattern(rawEventName: string): string {
  const trimmed = rawEventName.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    throw new BadRequestException(
      'eventName must be a non-empty identifier without whitespace (e.g. "order.paid" or "*")',
    );
  }
  return trimmed;
}

function buildCandidateEventPatterns(eventName: string): string[] {
  const patterns = new Set<string>(['*', eventName]);
  const segments = eventName.split('.');
  for (let i = 1; i < segments.length; i += 1) {
    patterns.add(`${segments.slice(0, i).join('.')}.*`);
  }
  return [...patterns];
}

@Injectable()
export class RulesService {
  readonly #prismaService: PrismaService;

  constructor(prismaService: PrismaService) {
    this.#prismaService = prismaService;
  }

  async createRule(workspaceId: string, dto: CreateRuleDto): Promise<RoutingRuleResponse> {
    const eventName = normalizeEventPattern(dto.eventName);
    await this.#assertIntegrationInWorkspace(workspaceId, dto.integrationId);

    const templateId = dto.templateId ?? null;
    if (templateId !== null) {
      await this.#assertTemplateInWorkspace(workspaceId, templateId);
    }

    const targetOverride =
      dto.targetOverride !== undefined && dto.targetOverride !== null
        ? dto.targetOverride.trim() || null
        : null;

    return this.#prismaService.routingRule.create({
      data: {
        workspaceId,
        eventName,
        integrationId: dto.integrationId,
        templateId,
        targetOverride,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async listRules(workspaceId: string, eventName?: string): Promise<RoutingRuleResponse[]> {
    const trimmedEvent = eventName?.trim();
    return this.#prismaService.routingRule.findMany({
      where: {
        workspaceId,
        ...(trimmedEvent && trimmedEvent.length > 0 ? { eventName: trimmedEvent } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateRule(
    workspaceId: string,
    ruleId: string,
    dto: UpdateRuleDto,
  ): Promise<RoutingRuleResponse> {
    const existing = await this.#prismaService.routingRule.findFirst({
      where: {
        id: ruleId,
        workspaceId,
      },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Routing rule not found');
    }

    const updateData: {
      eventName?: string;
      integrationId?: string;
      templateId?: string | null;
      targetOverride?: string | null;
      isActive?: boolean;
    } = {};

    if (dto.eventName !== undefined) {
      updateData.eventName = normalizeEventPattern(dto.eventName);
    }

    if (dto.integrationId !== undefined) {
      await this.#assertIntegrationInWorkspace(workspaceId, dto.integrationId);
      updateData.integrationId = dto.integrationId;
    }

    if (dto.templateId !== undefined) {
      if (dto.templateId !== null) {
        await this.#assertTemplateInWorkspace(workspaceId, dto.templateId);
      }
      updateData.templateId = dto.templateId;
    }

    if (dto.targetOverride !== undefined) {
      updateData.targetOverride =
        dto.targetOverride !== null && dto.targetOverride.trim().length > 0
          ? dto.targetOverride.trim()
          : null;
    }

    if (dto.isActive !== undefined) {
      updateData.isActive = dto.isActive;
    }

    return this.#prismaService.routingRule.update({
      where: { id: existing.id },
      data: updateData,
    });
  }

  async deleteRule(workspaceId: string, ruleId: string): Promise<void> {
    const deleted = await this.#prismaService.routingRule.deleteMany({
      where: {
        id: ruleId,
        workspaceId,
      },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Routing rule not found');
    }
  }

  async findMatchingRules(
    workspaceId: string,
    eventName: string,
  ): Promise<MatchedRoutingRuleRecord[]> {
    const trimmedEvent = normalizeEventPattern(eventName);
    const candidatePatterns = buildCandidateEventPatterns(trimmedEvent);

    return this.#prismaService.routingRule.findMany({
      where: {
        workspaceId,
        isActive: true,
        eventName: { in: candidatePatterns },
        integration: { isActive: true },
      },
      include: {
        integration: {
          select: {
            id: true,
            channel: true,
            provider: true,
            isActive: true,
          },
        },
        template: {
          select: {
            id: true,
            name: true,
            subjectTemplate: true,
            bodyTemplate: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  matchesEventPattern(ruleEventName: string, incomingEventName: string): boolean {
    if (ruleEventName === '*' || ruleEventName === incomingEventName) {
      return true;
    }

    if (ruleEventName.endsWith('.*')) {
      const prefix = ruleEventName.slice(0, -1); // retains trailing '.'
      return incomingEventName.startsWith(prefix) && incomingEventName.length > prefix.length;
    }

    return false;
  }

  evaluateCondition(
    condition: JsonLogicCondition | null | undefined,
    context: Record<string, unknown>,
  ): boolean {
    return evaluateJsonLogicCondition(condition, context);
  }

  resolveRecipientTarget(input: ResolveRecipientTargetInput): string | undefined {
    const trimmedOverride = input.targetOverride?.trim();
    if (trimmedOverride && trimmedOverride.length > 0) {
      if (trimmedOverride.startsWith('payload.') || trimmedOverride.startsWith('recipient.')) {
        const dynamicValue = getByPath(
          { payload: input.payload, recipient: input.recipient ?? {} },
          trimmedOverride,
        );
        return coerceTargetValue(dynamicValue);
      }
      return trimmedOverride;
    }

    if (input.recipient) {
      switch (input.channel) {
        case IntegrationChannel.EMAIL: {
          const fromRecipient = coerceTargetValue(getByPath(input.recipient, 'email'));
          if (fromRecipient) return fromRecipient;
          break;
        }
        case IntegrationChannel.TELEGRAM: {
          const fromRecipient = coerceTargetValue(getByPath(input.recipient, 'telegramChatId'));
          if (fromRecipient) return fromRecipient;
          break;
        }
        case IntegrationChannel.WEBHOOK: {
          const fromRecipient = coerceTargetValue(getByPath(input.recipient, 'webhookUrl'));
          if (fromRecipient) return fromRecipient;
          break;
        }
        case IntegrationChannel.SLACK: {
          const fromRecipient =
            coerceTargetValue(getByPath(input.recipient, 'slackWebhookUrl')) ??
            coerceTargetValue(getByPath(input.recipient, 'webhookUrl'));
          if (fromRecipient) return fromRecipient;
          break;
        }
      }
    }

    for (const candidatePath of CHANNEL_PAYLOAD_FALLBACK_PATHS[input.channel]) {
      const resolved = coerceTargetValue(getByPath(input.payload, candidatePath));
      if (resolved) {
        return resolved;
      }
    }

    return undefined;
  }

  evaluateRules<TRule extends EvaluableRule>(
    rules: readonly TRule[],
    context: RuleEvaluationContext,
  ): EvaluatedRuleMatch<TRule>[] {
    const evaluationData: Record<string, unknown> = {
      event: context.eventName,
      payload: context.payload,
      recipient: context.recipient ?? {},
    };

    const matches: EvaluatedRuleMatch<TRule>[] = [];
    for (const rule of rules) {
      if (rule.isActive === false) {
        continue;
      }
      if (!this.matchesEventPattern(rule.eventName, context.eventName)) {
        continue;
      }
      if (!this.evaluateCondition(rule.condition, evaluationData)) {
        continue;
      }

      const resolvedTarget = this.resolveRecipientTarget({
        channel: rule.channel,
        targetOverride: rule.targetOverride,
        recipient: context.recipient,
        payload: context.payload,
      });

      matches.push({
        rule,
        resolvedTarget,
      });
    }

    return matches;
  }

  async #assertIntegrationInWorkspace(workspaceId: string, integrationId: string): Promise<void> {
    const integration = await this.#prismaService.integration.findFirst({
      where: {
        id: integrationId,
        workspaceId,
      },
      select: { id: true },
    });

    if (!integration) {
      throw new BadRequestException('Target integration does not exist in this workspace');
    }
  }

  async #assertTemplateInWorkspace(workspaceId: string, templateId: string): Promise<void> {
    const template = await this.#prismaService.template.findFirst({
      where: {
        id: templateId,
        workspaceId,
      },
      select: { id: true },
    });

    if (!template) {
      throw new BadRequestException('Target template does not exist in this workspace');
    }
  }
}
