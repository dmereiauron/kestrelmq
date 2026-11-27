import { Injectable, UseGuards } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';
import * as z from 'zod';
import { ApiKeyGuard } from '../../../common/guards/api-key.guard.js';
import { AnalyticsService, type AnalyticsSummaryResponse } from '../../analytics/analytics.service.js';
import { ANALYTICS_WINDOWS } from '../../analytics/dto/get-analytics-summary-query.dto.js';
import { type KestrelMcpContext, resolveMcpWorkspaceId } from '../mcp-workspace.util.js';

export const analyticsSummaryInputSchema = z.strictObject({
  window: z.enum(ANALYTICS_WINDOWS).optional().describe('Lookback window: 24h (default), 7d or 30d'),
});

export type AnalyticsSummaryInput = z.infer<typeof analyticsSummaryInputSchema>;

@Injectable()
@UseGuards(ApiKeyGuard)
export class AnalyticsTools {
  readonly #analyticsService: AnalyticsService;

  constructor(analyticsService: AnalyticsService) {
    this.#analyticsService = analyticsService;
  }

  @Tool({
    name: 'get_analytics_summary',
    title: 'Get analytics summary',
    description:
      'Delivery metrics of the authenticated workspace over a window: total events and deliveries, counts per ' +
      'status, success rate (%), and average and p95 attempt duration (ms). Cached for 60 seconds.',
    inputSchema: analyticsSummaryInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  })
  async getAnalyticsSummary(
    input: AnalyticsSummaryInput,
    ctx: KestrelMcpContext,
  ): Promise<AnalyticsSummaryResponse> {
    const workspaceId = resolveMcpWorkspaceId(ctx);
    return this.#analyticsService.getSummary(workspaceId, input.window ?? '24h');
  }
}
