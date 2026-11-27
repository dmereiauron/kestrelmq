import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import Handlebars from 'handlebars';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { FORBIDDEN_PATH_SEGMENTS } from '../../common/utils/get-by-path.util.js';
import { IntegrationChannel } from '../../generated/prisma/enums.js';
import type { CreateTemplateDto } from './dto/create-template.dto.js';
import type { UpdateTemplateDto } from './dto/update-template.dto.js';

export interface TemplateResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly subjectTemplate: string | null;
  readonly bodyTemplate: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TemplateSourceLike {
  readonly subjectTemplate: string | null;
  readonly bodyTemplate: string;
}

export interface ResolveContentInput {
  readonly channel: IntegrationChannel;
  readonly template: TemplateSourceLike | null;
  readonly payload: Record<string, unknown>;
}

export interface ResolvedNotificationContent {
  readonly subject?: string;
  readonly body: string;
  readonly html?: string;
  readonly text?: string;
}

export class TemplateResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateResolutionError';
  }
}

const HANDLEBARS_RUNTIME_OPTIONS: Handlebars.RuntimeOptions = {
  allowProtoPropertiesByDefault: false,
  allowProtoMethodsByDefault: false,
};

const MAX_COMPILED_CACHE_SIZE = 500;

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function sanitizeContextValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeContextValue(item, seen));
  }

  const sanitized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
      continue;
    }
    if (Object.hasOwn(value, key)) {
      sanitized[key] = sanitizeContextValue((value as Record<string, unknown>)[key], seen);
    }
  }
  return sanitized;
}

@Injectable()
export class TemplatesService {
  readonly #prismaService: PrismaService;
  readonly #handlebars: typeof Handlebars;
  readonly #compiledCache = new Map<string, Handlebars.TemplateDelegate>();

  constructor(prismaService: PrismaService) {
    this.#prismaService = prismaService;
    this.#handlebars = Handlebars.create();
    this.#handlebars.logger.log = (): void => {};
  }

  async createTemplate(
    workspaceId: string,
    dto: CreateTemplateDto,
  ): Promise<TemplateResponse> {
    const trimmedName = dto.name.trim();
    if (trimmedName.length === 0) {
      throw new BadRequestException('Template name must not be empty');
    }

    const normalizedSubject =
      dto.subjectTemplate !== undefined && dto.subjectTemplate !== null
        ? dto.subjectTemplate.trim()
        : null;

    if (normalizedSubject !== null && normalizedSubject.length > 0) {
      this.validateTemplateSyntax(normalizedSubject, 'subjectTemplate');
    }
    this.validateTemplateSyntax(dto.bodyTemplate, 'bodyTemplate');

    return this.#prismaService.template.create({
      data: {
        workspaceId,
        name: trimmedName,
        subjectTemplate:
          normalizedSubject !== null && normalizedSubject.length > 0 ? normalizedSubject : null,
        bodyTemplate: dto.bodyTemplate,
      },
    });
  }

  async listTemplates(workspaceId: string): Promise<TemplateResponse[]> {
    return this.#prismaService.template.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTemplate(workspaceId: string, templateId: string): Promise<TemplateResponse> {
    const template = await this.#prismaService.template.findFirst({
      where: {
        id: templateId,
        workspaceId,
      },
    });

    if (!template) {
      throw new NotFoundException('Template not found');
    }

    return template;
  }

  async updateTemplate(
    workspaceId: string,
    templateId: string,
    dto: UpdateTemplateDto,
  ): Promise<TemplateResponse> {
    const existing = await this.#prismaService.template.findFirst({
      where: {
        id: templateId,
        workspaceId,
      },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Template not found');
    }

    const updateData: {
      name?: string;
      subjectTemplate?: string | null;
      bodyTemplate?: string;
    } = {};

    if (dto.name !== undefined) {
      const trimmedName = dto.name.trim();
      if (trimmedName.length === 0) {
        throw new BadRequestException('Template name must not be empty');
      }
      updateData.name = trimmedName;
    }

    if (dto.subjectTemplate !== undefined) {
      if (dto.subjectTemplate === null || dto.subjectTemplate.trim().length === 0) {
        updateData.subjectTemplate = null;
      } else {
        const trimmedSubject = dto.subjectTemplate.trim();
        this.validateTemplateSyntax(trimmedSubject, 'subjectTemplate');
        updateData.subjectTemplate = trimmedSubject;
      }
    }

    if (dto.bodyTemplate !== undefined) {
      this.validateTemplateSyntax(dto.bodyTemplate, 'bodyTemplate');
      updateData.bodyTemplate = dto.bodyTemplate;
    }

    return this.#prismaService.template.update({
      where: { id: existing.id },
      data: updateData,
    });
  }

  async deleteTemplate(workspaceId: string, templateId: string): Promise<void> {
    const deleted = await this.#prismaService.template.deleteMany({
      where: {
        id: templateId,
        workspaceId,
      },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Template not found');
    }
  }

  validateTemplateSyntax(source: string, fieldName = 'template'): void {
    try {
      const ast = this.#handlebars.parse(source);
      this.#handlebars.precompile(ast);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'Syntax error';
      throw new BadRequestException(`Invalid Handlebars syntax in ${fieldName}: ${reason}`);
    }
  }

  renderTemplate(source: string, variables: Record<string, unknown>): string {
    const compiled = this.#getOrCompile(source);
    const safeContext = sanitizeContextValue(variables) as Record<string, unknown>;
    return compiled(safeContext, HANDLEBARS_RUNTIME_OPTIONS);
  }

  resolveContent(input: ResolveContentInput): ResolvedNotificationContent {
    if (input.template !== null) {
      const renderedBody = this.renderTemplate(input.template.bodyTemplate, input.payload);
      const renderedSubject =
        input.template.subjectTemplate !== null
          ? this.renderTemplate(input.template.subjectTemplate, input.payload).trim()
          : undefined;

      if (input.channel === IntegrationChannel.EMAIL) {
        const effectiveSubject =
          renderedSubject && renderedSubject.length > 0
            ? renderedSubject
            : readNonEmptyString(input.payload['subject'])?.trim();

        if (!effectiveSubject) {
          throw new TemplateResolutionError(
            'Email delivery requires a non-empty subjectTemplate or payload.subject',
          );
        }

        if (renderedBody.trim().length === 0) {
          throw new TemplateResolutionError('Email template rendered an empty body');
        }

        const fallbackText = readNonEmptyString(input.payload['text']);
        return {
          subject: effectiveSubject,
          body: renderedBody,
          html: renderedBody,
          ...(fallbackText !== undefined ? { text: fallbackText } : {}),
        };
      }

      if (
        input.channel === IntegrationChannel.TELEGRAM ||
        input.channel === IntegrationChannel.SLACK
      ) {
        if (renderedBody.trim().length === 0) {
          throw new TemplateResolutionError(`${input.channel} template rendered an empty body`);
        }

        return {
          ...(renderedSubject && renderedSubject.length > 0 ? { subject: renderedSubject } : {}),
          body: renderedBody,
          text: renderedBody,
        };
      }

      return {
        ...(renderedSubject && renderedSubject.length > 0 ? { subject: renderedSubject } : {}),
        body: renderedBody,
      };
    }

    // BYOT (Bring Your Own Template) fallback when templateId is null (SPEC.md §3.3 Step 5)
    const rawSubject = readNonEmptyString(input.payload['subject'])?.trim();
    const rawHtml = readNonEmptyString(input.payload['html']);
    const rawText = readNonEmptyString(input.payload['text']);

    switch (input.channel) {
      case IntegrationChannel.EMAIL: {
        if (!rawSubject) {
          throw new TemplateResolutionError(
            'BYOT Email delivery requires a non-empty payload.subject when templateId is null',
          );
        }
        if (!rawHtml && !rawText) {
          throw new TemplateResolutionError(
            'BYOT Email delivery requires payload.html or payload.text when templateId is null',
          );
        }
        return {
          subject: rawSubject,
          body: rawHtml ?? rawText!,
          ...(rawHtml !== undefined ? { html: rawHtml } : {}),
          ...(rawText !== undefined ? { text: rawText } : {}),
        };
      }
      case IntegrationChannel.TELEGRAM:
      case IntegrationChannel.SLACK: {
        if (!rawText) {
          throw new TemplateResolutionError(
            `BYOT ${input.channel} delivery requires a non-empty payload.text when templateId is null`,
          );
        }
        return {
          ...(rawSubject !== undefined ? { subject: rawSubject } : {}),
          body: rawText,
          text: rawText,
        };
      }
      case IntegrationChannel.WEBHOOK: {
        const body = rawText ?? JSON.stringify(input.payload);
        return {
          ...(rawSubject !== undefined ? { subject: rawSubject } : {}),
          body,
          ...(rawText !== undefined ? { text: rawText } : {}),
        };
      }
    }
  }

  #getOrCompile(source: string): Handlebars.TemplateDelegate {
    const cached = this.#compiledCache.get(source);
    if (cached) {
      return cached;
    }

    this.validateTemplateSyntax(source);
    const compiled = this.#handlebars.compile(source);

    if (this.#compiledCache.size >= MAX_COMPILED_CACHE_SIZE) {
      const oldestKey = this.#compiledCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.#compiledCache.delete(oldestKey);
      }
    }

    this.#compiledCache.set(source, compiled);
    return compiled;
  }
}
