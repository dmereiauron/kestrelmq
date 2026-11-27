import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { IntegrationChannel } from '../../generated/prisma/enums.js';
import { CreateTemplateDto } from './dto/create-template.dto.js';
import { UpdateTemplateDto } from './dto/update-template.dto.js';
import { TemplatesController } from './templates.controller.js';
import { TemplateResolutionError, TemplatesService } from './templates.service.js';

describe('TemplatesService & TemplatesController', () => {
  let templateCreateMock: ReturnType<typeof vi.fn>;
  let templateFindManyMock: ReturnType<typeof vi.fn>;
  let templateFindFirstMock: ReturnType<typeof vi.fn>;
  let templateUpdateMock: ReturnType<typeof vi.fn>;
  let templateDeleteManyMock: ReturnType<typeof vi.fn>;
  let service: TemplatesService;
  let controller: TemplatesController;

  beforeEach(() => {
    templateCreateMock = vi.fn();
    templateFindManyMock = vi.fn();
    templateFindFirstMock = vi.fn();
    templateUpdateMock = vi.fn();
    templateDeleteManyMock = vi.fn();

    const prismaService = {
      template: {
        create: templateCreateMock,
        findMany: templateFindManyMock,
        findFirst: templateFindFirstMock,
        update: templateUpdateMock,
        deleteMany: templateDeleteManyMock,
      },
    } as unknown as PrismaService;

    service = new TemplatesService(prismaService);
    controller = new TemplatesController(service);
  });

  it('performs workspace-scoped CRUD and rejects invalid Handlebars syntax with 400', async () => {
    const workspaceId = randomUUID();
    const templateId = randomUUID();
    const now = new Date();

    // Unclosed block -> 400
    await expect(
      controller.createTemplate(workspaceId, {
        name: 'Broken Template',
        bodyTemplate: 'Hello {{#if customer.vip}}VIP',
      }),
    ).rejects.toThrow(BadRequestException);

    // Empty trimmed name -> 400
    await expect(
      controller.createTemplate(workspaceId, {
        name: '   ',
        bodyTemplate: 'Hello {{name}}',
      }),
    ).rejects.toThrow(BadRequestException);

    templateCreateMock.mockImplementation(
      async ({
        data,
      }: {
        data: {
          workspaceId: string;
          name: string;
          subjectTemplate: string | null;
          bodyTemplate: string;
        };
      }) => ({
        id: templateId,
        ...data,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const created = await controller.createTemplate(workspaceId, {
      name: 'Order Paid Email',
      subjectTemplate: 'Order #{{orderId}} confirmed',
      bodyTemplate: '<p>Hi {{customer.name}}, total: {{amount}}</p>',
    });
    expect(created.id).toBe(templateId);
    expect(created.subjectTemplate).toBe('Order #{{orderId}} confirmed');

    templateFindManyMock.mockResolvedValueOnce([created]);
    await expect(controller.listTemplates(workspaceId)).resolves.toEqual([created]);

    templateFindFirstMock.mockResolvedValueOnce(created);
    await expect(controller.getTemplate(workspaceId, templateId)).resolves.toEqual(created);

    templateFindFirstMock.mockResolvedValueOnce(null);
    await expect(controller.getTemplate(workspaceId, randomUUID())).rejects.toThrow(
      NotFoundException,
    );

    // Update template (clearing subjectTemplate to null)
    templateFindFirstMock.mockResolvedValueOnce({ id: templateId });
    templateUpdateMock.mockResolvedValueOnce({
      ...created,
      name: 'Updated Order Template',
      subjectTemplate: null,
    });
    const updated = await controller.updateTemplate(workspaceId, templateId, {
      name: 'Updated Order Template',
      subjectTemplate: null,
      bodyTemplate: '<p>Updated {{orderId}}</p>',
    });
    expect(updated.subjectTemplate).toBeNull();

    // Update non-existent -> 404
    templateFindFirstMock.mockResolvedValueOnce(null);
    await expect(
      controller.updateTemplate(workspaceId, randomUUID(), { name: 'Nope' }),
    ).rejects.toThrow(NotFoundException);

    // Delete -> 204 & 404
    templateDeleteManyMock.mockResolvedValueOnce({ count: 1 });
    await expect(controller.deleteTemplate(workspaceId, templateId)).resolves.toBeUndefined();

    templateDeleteManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(controller.deleteTemplate(workspaceId, randomUUID())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('compiles Handlebars templates with prototype access disabled and blocks __proto__/constructor leaks', () => {
    class AccountModel {
      readonly ownerName = 'Grace';

      get secretProtoGetter(): string {
        return 'LEAKED_GETTER';
      }

      protoMethod(): string {
        return 'LEAKED_METHOD';
      }
    }

    const instance = new AccountModel();
    const jsonAttack = JSON.parse(
      '{"__proto__": {"polluted": "PWNED"}, "constructor": {"name": "Attack"}, "orderId": "ORD-77"}',
    ) as Record<string, unknown>;

    const circular: Record<string, unknown> = { label: 'ok', at: new Date('2026-11-26T12:00:00Z') };
    circular['self'] = circular;

    const renderedInstance = service.renderTemplate(
      'Owner={{ownerName}}|Getter={{secretProtoGetter}}|Method={{protoMethod}}|Ctor={{constructor.name}}',
      instance as unknown as Record<string, unknown>,
    );
    expect(renderedInstance).toBe('Owner=Grace|Getter=|Method=|Ctor=');

    // Second render exercises the compiled template cache
    const renderedAttack = service.renderTemplate(
      'Order={{orderId}}|Proto={{__proto__.polluted}}|Ctor={{constructor.name}}',
      jsonAttack,
    );
    expect(renderedAttack).toBe('Order=ORD-77|Proto=|Ctor=');

    const renderedCached = service.renderTemplate(
      'Order={{orderId}}|Proto={{__proto__.polluted}}|Ctor={{constructor.name}}',
      jsonAttack,
    );
    expect(renderedCached).toBe('Order=ORD-77|Proto=|Ctor=');

    const renderedCircular = service.renderTemplate('{{label}} @ {{at}}', circular);
    expect(renderedCircular).toBe('ok @ 2026-11-26T12:00:00.000Z');
  });

  it('resolves template-rendered content and enforces BYOT fallback rules when template is null', () => {
    // 1. Template present (EMAIL)
    const emailFromTemplate = service.resolveContent({
      channel: IntegrationChannel.EMAIL,
      template: {
        subjectTemplate: 'Invoice #{{invoiceId}}',
        bodyTemplate: '<h1>Amount: {{amount}}</h1>',
      },
      payload: { invoiceId: 'INV-9', amount: '$49.00', text: 'Amount: $49.00' },
    });
    expect(emailFromTemplate).toEqual({
      subject: 'Invoice #INV-9',
      body: '<h1>Amount: $49.00</h1>',
      html: '<h1>Amount: $49.00</h1>',
      text: 'Amount: $49.00',
    });

    // Template present (TELEGRAM & WEBHOOK)
    const tgFromTemplate = service.resolveContent({
      channel: IntegrationChannel.TELEGRAM,
      template: {
        subjectTemplate: null,
        bodyTemplate: '<b>Deploy {{env}}</b>',
      },
      payload: { env: 'prod' },
    });
    expect(tgFromTemplate).toEqual({
      body: '<b>Deploy prod</b>',
      text: '<b>Deploy prod</b>',
    });

    const whFromTemplate = service.resolveContent({
      channel: IntegrationChannel.WEBHOOK,
      template: {
        subjectTemplate: null,
        bodyTemplate: '{"id":"{{id}}"}',
      },
      payload: { id: 'evt_1' },
    });
    expect(whFromTemplate).toEqual({ body: '{"id":"evt_1"}' });

    // 2. BYOT mode (template === null) for EMAIL
    const byotEmail = service.resolveContent({
      channel: IntegrationChannel.EMAIL,
      template: null,
      payload: {
        subject: 'Welcome aboard!',
        html: '<p>Rendered by React Email</p>',
        text: 'Rendered by React Email',
      },
    });
    expect(byotEmail).toEqual({
      subject: 'Welcome aboard!',
      body: '<p>Rendered by React Email</p>',
      html: '<p>Rendered by React Email</p>',
      text: 'Rendered by React Email',
    });

    // BYOT EMAIL missing subject or html/text -> fatal TemplateResolutionError
    expect(() =>
      service.resolveContent({
        channel: IntegrationChannel.EMAIL,
        template: null,
        payload: { html: '<p>No subject</p>' },
      }),
    ).toThrow(TemplateResolutionError);

    expect(() =>
      service.resolveContent({
        channel: IntegrationChannel.EMAIL,
        template: null,
        payload: { subject: 'No body' },
      }),
    ).toThrow(TemplateResolutionError);

    // 3. BYOT mode for TELEGRAM -> requires payload.text
    expect(
      service.resolveContent({
        channel: IntegrationChannel.TELEGRAM,
        template: null,
        payload: { text: '<b>Pre-rendered Telegram alert</b>' },
      }),
    ).toEqual({
      body: '<b>Pre-rendered Telegram alert</b>',
      text: '<b>Pre-rendered Telegram alert</b>',
    });

    expect(() =>
      service.resolveContent({
        channel: IntegrationChannel.TELEGRAM,
        template: null,
        payload: { orderId: 123 },
      }),
    ).toThrow(TemplateResolutionError);

    // 4. BYOT mode for WEBHOOK -> serializes JSON when payload.text is absent
    expect(
      service.resolveContent({
        channel: IntegrationChannel.WEBHOOK,
        template: null,
        payload: { event: 'order.paid', total: 199 },
      }),
    ).toEqual({
      body: JSON.stringify({ event: 'order.paid', total: 199 }),
    });
  });

  it('validates CreateTemplateDto and UpdateTemplateDto constraints', async () => {
    expect(
      await validate(
        plainToInstance(CreateTemplateDto, {
          name: 'Alert',
          subjectTemplate: 'Subj',
          bodyTemplate: 'Body',
        }),
      ),
    ).toHaveLength(0);

    expect(
      await validate(
        plainToInstance(UpdateTemplateDto, {
          subjectTemplate: null,
        }),
      ),
    ).toHaveLength(0);
  });
});
