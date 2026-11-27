import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { AnalyticsService, type AnalyticsSummaryResponse } from './analytics.service.js';
import { GetAnalyticsSummaryQueryDto } from './dto/get-analytics-summary-query.dto.js';

@Controller('analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AnalyticsController {
  readonly #analyticsService: AnalyticsService;

  constructor(analyticsService: AnalyticsService) {
    this.#analyticsService = analyticsService;
  }

  @Get('summary')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  async getSummary(
    @CurrentWorkspaceId() workspaceId: string,
    @Query() query: GetAnalyticsSummaryQueryDto,
  ): Promise<AnalyticsSummaryResponse> {
    return this.#analyticsService.getSummary(workspaceId, query.window ?? '24h');
  }
}
