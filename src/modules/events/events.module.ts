import { Module } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/guards/api-key.guard.js';
import { QueueModule } from '../../common/queue/queue.module.js';
import { RulesModule } from '../rules/rules.module.js';
import { EventSchemasModule } from '../schemas/event-schemas.module.js';
import { EventsController } from './events.controller.js';
import { IngestionService } from './ingestion.service.js';

@Module({
  imports: [QueueModule, EventSchemasModule, RulesModule],
  controllers: [EventsController],
  providers: [IngestionService, ApiKeyGuard],
  exports: [IngestionService],
})
export class EventsModule {}

export { EventsModule as IngestionModule };
