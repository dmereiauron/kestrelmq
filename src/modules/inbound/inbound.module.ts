import { Module } from '@nestjs/common';
import { QueueModule } from '../../common/queue/queue.module.js';
import { InboundGatewayController } from './inbound-gateway.controller.js';
import { InboundSourcesController } from './inbound-sources.controller.js';
import { InboundService } from './inbound.service.js';

@Module({
  imports: [QueueModule],
  controllers: [InboundSourcesController, InboundGatewayController],
  providers: [InboundService],
  exports: [InboundService],
})
export class InboundModule {}
