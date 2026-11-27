import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { ApiKeyGuard } from '../../common/guards/api-key.guard.js';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import type { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface.js';
import { type BulkIngestResponse, BulkEventsService } from './bulk-events.service.js';
import { IngestEventDto } from './dto/ingest-event.dto.js';
import { type IngestEventResponse, IngestionService } from './ingestion.service.js';

@Controller('events')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class EventsController {
  readonly #ingestionService: IngestionService;
  readonly #bulkEventsService: BulkEventsService;

  constructor(ingestionService: IngestionService, bulkEventsService: BulkEventsService) {
    this.#ingestionService = ingestionService;
    this.#bulkEventsService = bulkEventsService;
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

  @Post('bulk')
  @HttpCode(HttpStatus.ACCEPTED)
  async ingestBulkEvents(
    @CurrentWorkspaceId() workspaceId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<BulkIngestResponse> {
    return this.#bulkEventsService.ingestMultipartStream(workspaceId, request);
  }
}
