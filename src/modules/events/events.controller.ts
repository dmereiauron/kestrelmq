import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { ApiKeyGuard } from '../../common/guards/api-key.guard.js';
import { IngestEventDto } from './dto/ingest-event.dto.js';
import { type IngestEventResponse, IngestionService } from './ingestion.service.js';

@Controller('events')
@UseGuards(ApiKeyGuard)
export class EventsController {
  readonly #ingestionService: IngestionService;

  constructor(ingestionService: IngestionService) {
    this.#ingestionService = ingestionService;
  }

  @Post()
  async ingestEvent(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: IngestEventDto,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<IngestEventResponse> {
    const result = await this.#ingestionService.ingestEvent(
      workspaceId,
      dto,
      idempotencyKeyHeader,
    );

    response.status(result.idempotentReplay ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return result;
  }
}
