import { IsIn, IsOptional, IsUUID } from 'class-validator';

export const ANALYTICS_WINDOWS = ['24h', '7d', '30d'] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];

export class GetAnalyticsSummaryQueryDto {
  @IsOptional()
  @IsIn(ANALYTICS_WINDOWS)
  window?: AnalyticsWindow;

  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}
