import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard.js';
import { ApiWorkspaceJwtOrApiKeyAuth } from '../../common/swagger/api-workspace-header.decorator.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { AnalyticsService, type AnalyticsSummaryResponse } from './analytics.service.js';
import { GetAnalyticsSummaryQueryDto } from './dto/get-analytics-summary-query.dto.js';

@ApiTags('Analytics')
@ApiWorkspaceJwtOrApiKeyAuth()
@Controller('analytics')
@UseGuards(JwtOrApiKeyGuard)
export class AnalyticsController {
  readonly #analyticsService: AnalyticsService;

  constructor(analyticsService: AnalyticsService) {
    this.#analyticsService = analyticsService;
  }

  @Get('summary')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({
    summary: 'Get aggregated workspace delivery metrics and p95 latency (60s Redis Cache-Aside)',
  })
  @ApiOkResponse({ description: 'Aggregated delivery analytics summary' })
  async getSummary(
    @CurrentWorkspaceId() workspaceId: string,
    @Query() query: GetAnalyticsSummaryQueryDto,
  ): Promise<AnalyticsSummaryResponse> {
    return this.#analyticsService.getSummary(workspaceId, query.window ?? '24h');
  }
}
