import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/guards/api-key.guard.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { QueueModule } from '../../common/queue/queue.module.js';
import { DeliveriesController } from './deliveries.controller.js';
import { DeliveriesService } from './deliveries.service.js';

@Module({
  imports: [QueueModule],
  controllers: [DeliveriesController],
  providers: [DeliveriesService, ApiKeyGuard, JwtAuthGuard, RolesGuard, JwtOrApiKeyGuard],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
