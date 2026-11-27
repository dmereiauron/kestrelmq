import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/guards/api-key.guard.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, ApiKeyGuard, JwtAuthGuard, RolesGuard, JwtOrApiKeyGuard],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
