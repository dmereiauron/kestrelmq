import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsService } from '../../analytics/analytics.service.js';
import { createWorkspaceMcpContext } from '../testing/mcp-context.fixture.js';
import { AnalyticsTools, analyticsSummaryInputSchema } from './analytics.tools.js';

describe('AnalyticsTools.get_analytics_summary', () => {
  let getSummary: ReturnType<typeof vi.fn>;
  let tools: AnalyticsTools;

  beforeEach(() => {
    getSummary = vi.fn().mockResolvedValue({ workspaceId: 'ws-a', window: '7d', cached: true });
    tools = new AnalyticsTools({ getSummary } as unknown as AnalyticsService);
  });

  it('returns the cached summary for the requested window', async () => {
    await expect(
      tools.getAnalyticsSummary({ window: '7d' }, createWorkspaceMcpContext('ws-a')),
    ).resolves.toEqual({ workspaceId: 'ws-a', window: '7d', cached: true });
    expect(getSummary).toHaveBeenCalledWith('ws-a', '7d');
  });

  it('defaults to the 24h window', async () => {
    await tools.getAnalyticsSummary({}, createWorkspaceMcpContext('ws-a'));
    expect(getSummary).toHaveBeenCalledWith('ws-a', '24h');
  });

  it('only accepts 24h, 7d and 30d', () => {
    expect(analyticsSummaryInputSchema.safeParse({ window: '1y' }).success).toBe(false);
    expect(analyticsSummaryInputSchema.safeParse({ window: '30d' }).success).toBe(true);
  });
});
