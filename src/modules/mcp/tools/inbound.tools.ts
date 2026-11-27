import { Injectable, UseGuards } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';
import * as z from 'zod';
import { ApiKeyGuard } from '../../../common/guards/api-key.guard.js';
import { type InboundSourceResponse, InboundService } from '../../inbound/inbound.service.js';
import { type KestrelMcpContext, resolveMcpWorkspaceId } from '../mcp-workspace.util.js';

export const INBOUND_TOGGLE_ACTIONS = ['pause', 'resume'] as const;

export const toggleInboundSourceInputSchema = z.strictObject({
  sourceId: z.uuid().describe('Inbound webhook source id'),
  action: z
    .enum(INBOUND_TOGGLE_ACTIONS)
    .describe(
      'pause: buffer incoming webhooks as PAUSED deliveries; resume: drain them at max_rate_per_sec',
    ),
});

export type ToggleInboundSourceInput = z.infer<typeof toggleInboundSourceInputSchema>;

export interface ToggleInboundSourceResult {
  readonly action: (typeof INBOUND_TOGGLE_ACTIONS)[number];
  readonly source: InboundSourceResponse;
  readonly resumedDeliveriesCount?: number;
}

@Injectable()
@UseGuards(ApiKeyGuard)
export class InboundTools {
  readonly #inboundService: InboundService;

  constructor(inboundService: InboundService) {
    this.#inboundService = inboundService;
  }

  @Tool({
    name: 'toggle_inbound_source',
    title: 'Pause or resume inbound source',
    description:
      'Pause an inbound webhook source of the authenticated workspace (e.g. during a deployment or migration) so ' +
      'incoming webhooks are buffered without loss, or resume it so buffered deliveries drain smoothly at the ' +
      "source's max_rate_per_sec.",
    inputSchema: toggleInboundSourceInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  })
  async toggleInboundSource(
    input: ToggleInboundSourceInput,
    ctx: KestrelMcpContext,
  ): Promise<ToggleInboundSourceResult> {
    const workspaceId = resolveMcpWorkspaceId(ctx);

    if (input.action === 'pause') {
      const source = await this.#inboundService.pauseSource(workspaceId, input.sourceId);
      return { action: 'pause', source };
    }

    const resumed = await this.#inboundService.resumeSource(workspaceId, input.sourceId);
    return {
      action: 'resume',
      source: resumed.source,
      resumedDeliveriesCount: resumed.resumedDeliveriesCount,
    };
  }
}
