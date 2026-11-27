import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export const ANALYTICS_WINDOWS = ['24h', '7d', '30d'] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];

export class GetAnalyticsSummaryQueryDto {
  @ApiPropertyOptional({
    enum: ANALYTICS_WINDOWS,
    default: '24h',
    example: '24h',
    description: 'Aggregation lookback window (24h, 7d, or 30d)',
  })
  @IsOptional()
  @IsIn(ANALYTICS_WINDOWS)
  window?: AnalyticsWindow;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Optional workspace UUID fallback when authenticating via JWT',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}
