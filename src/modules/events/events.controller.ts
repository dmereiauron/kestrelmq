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
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { ApiKeyGuard } from '../../common/guards/api-key.guard.js';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard.js';
import type { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface.js';
import {
  SWAGGER_API_KEY_AUTH,
  SWAGGER_BEARER_AUTH,
} from '../../common/swagger/api-workspace-header.decorator.js';
import { ProblemDetailsDto } from '../../common/swagger/problem-details.dto.js';
import { type BulkIngestResponse, BulkEventsService } from './bulk-events.service.js';
import { IngestEventDto } from './dto/ingest-event.dto.js';
import { type IngestEventResponse, IngestionService } from './ingestion.service.js';

@ApiTags('Events')
@ApiSecurity(SWAGGER_API_KEY_AUTH)
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
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
  @ApiOperation({
    summary: 'Ingest a single outbound notification event and fan out to BullMQ deliveries',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Optional deduplication key (24h TTL in Redis + PostgreSQL partial unique index)',
    schema: { type: 'string', maxLength: 255 },
  })
  @ApiResponse({ status: 202, description: 'Event accepted and deliveries enqueued' })
  @ApiResponse({ status: 200, description: 'Idempotent replay of previously accepted event' })
  @ApiResponse({
    status: 400,
    description: 'Invalid payload or STRICT Ajv schema validation failure',
    type: ProblemDetailsDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key', type: ProblemDetailsDto })
  @ApiResponse({
    status: 429,
    description: 'Workspace sliding-window rate limit exceeded',
    type: ProblemDetailsDto,
  })
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
  @ApiOperation({
    summary: 'Stream and ingest bulk events from an RFC 4180 CSV file (multipart/form-data)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'CSV file with columns: event_name (or event), payload, optional recipient, idempotency_key, deliver_at',
        },
      },
    },
  })
  @ApiResponse({ status: 202, description: 'CSV stream processed and valid deliveries enqueued' })
  @ApiResponse({ status: 400, description: 'Malformed CSV or multipart request', type: ProblemDetailsDto })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key', type: ProblemDetailsDto })
  @ApiResponse({
    status: 413,
    description: 'CSV exceeds maximum file size (10 MiB) or row limit (10,000 rows)',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 429,
    description: 'Workspace sliding-window rate limit exceeded',
    type: ProblemDetailsDto,
  })
  async ingestBulkEvents(
    @CurrentWorkspaceId() workspaceId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<BulkIngestResponse> {
    return this.#bulkEventsService.ingestMultipartStream(workspaceId, request);
  }
}
