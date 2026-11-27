import { Module } from '@nestjs/common';
import { EventSchemasController } from './event-schemas.controller.js';
import { EventSchemasService } from './event-schemas.service.js';

@Module({
  controllers: [EventSchemasController],
  providers: [EventSchemasService],
  exports: [EventSchemasService],
})
export class EventSchemasModule {}
