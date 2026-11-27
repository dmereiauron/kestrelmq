import { Injectable, UseGuards } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';
import * as z from 'zod';
import { ApiKeyGuard } from '../../../common/guards/api-key.guard.js';
import type { IngestEventDto } from '../../events/dto/ingest-event.dto.js';
import { type IngestEventResponse, IngestionService } from '../../events/ingestion.service.js';
import { type KestrelMcpContext, resolveMcpWorkspaceId } from '../mcp-workspace.util.js';

export const sendEventInputSchema = z.strictObject({
  event: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\S+$/u, 'event must be a non-empty identifier without whitespace')
    .describe('Event name matched against routing rules, e.g. "order.paid"'),
  payload: z
    .record(z.string(), z.unknown())
    .describe('JSON event payload passed to templates and provider adapters'),
  recipient: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Optional explicit recipient envelope (email, telegramChatId, webhookUrl); resolved from payload when omitted',
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Optional deduplication key; repeating a call with the same key returns the original result (24h)'),
  deliverAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Optional ISO-8601 timestamp for delayed delivery'),
});

export type SendEventInput = z.infer<typeof sendEventInputSchema>;

@Injectable()
@UseGuards(ApiKeyGuard)
export class EventTools {
  readonly #ingestionService: IngestionService;

  constructor(ingestionService: IngestionService) {
    this.#ingestionService = ingestionService;
  }

  @Tool({
    name: 'send_event',
    title: 'Send event',
    description:
      'Enqueue an outbound notification event for the authenticated workspace. Matching routing rules fan out into ' +
      'deliveries processed asynchronously by background workers. Read kestrelmq://schemas first to see the ' +
      'expected payload contract. Pass idempotencyKey to make retries of this call safe.',
    inputSchema: sendEventInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  })
  async sendEvent(input: SendEventInput, ctx: KestrelMcpContext): Promise<IngestEventResponse> {
    const workspaceId = resolveMcpWorkspaceId(ctx);
    const dto: IngestEventDto = {
      event: input.event,
      payload: input.payload,
      ...(input.recipient !== undefined ? { recipient: input.recipient } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.deliverAt !== undefined ? { deliverAt: input.deliverAt } : {}),
    };
    return this.#ingestionService.ingestEvent(workspaceId, dto);
  }
}
