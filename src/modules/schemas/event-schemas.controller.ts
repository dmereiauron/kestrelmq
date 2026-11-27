import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { ApiWorkspaceJwtAuth } from '../../common/swagger/api-workspace-header.decorator.js';
import { ProblemDetailsDto } from '../../common/swagger/problem-details.dto.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { InferSchemaDto } from './dto/infer-schema.dto.js';
import { UpdateEventSchemaDto } from './dto/update-event-schema.dto.js';
import { UpsertEventSchemaDto } from './dto/upsert-event-schema.dto.js';
import {
  type EventSchemaResponse,
  EventSchemasService,
  type InferSchemaResponse,
} from './event-schemas.service.js';

@ApiTags('Event Schemas')
@ApiWorkspaceJwtAuth()
@Controller('schemas')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EventSchemasController {
  readonly #eventSchemasService: EventSchemasService;

  constructor(eventSchemasService: EventSchemasService) {
    this.#eventSchemasService = eventSchemasService;
  }

  @Post('infer')
  @HttpCode(HttpStatus.OK)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({ summary: 'Infer Draft-07 JSON Schema and dot-path variables from sample payload' })
  @ApiOkResponse({ description: 'Inferred JSON Schema and dot-path variables' })
  inferSchema(@Body() dto: InferSchemaDto): InferSchemaResponse {
    return this.#eventSchemasService.inferFromSample(dto.samplePayload);
  }

  @Post()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Create or upsert an event payload schema and Ajv validation mode' })
  @ApiResponse({ status: 201, description: 'Event schema upserted' })
  @ApiResponse({ status: 400, description: 'Invalid JSON Schema', type: ProblemDetailsDto })
  async upsertSchema(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: UpsertEventSchemaDto,
  ): Promise<EventSchemaResponse> {
    return this.#eventSchemasService.upsertSchema(workspaceId, dto);
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({ summary: 'List registered event schemas in the workspace' })
  @ApiOkResponse({ description: 'List of event schemas' })
  async listSchemas(@CurrentWorkspaceId() workspaceId: string): Promise<EventSchemaResponse[]> {
    return this.#eventSchemasService.listSchemas(workspaceId);
  }

  @Patch(':id')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Update event schema or validation mode (DISABLED / WARN / STRICT)' })
  @ApiOkResponse({ description: 'Updated event schema' })
  @ApiResponse({ status: 404, description: 'Event schema not found', type: ProblemDetailsDto })
  async updateSchema(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) schemaId: string,
    @Body() dto: UpdateEventSchemaDto,
  ): Promise<EventSchemaResponse> {
    return this.#eventSchemasService.updateSchema(workspaceId, schemaId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Delete an event schema' })
  @ApiNoContentResponse({ description: 'Event schema deleted' })
  @ApiResponse({ status: 404, description: 'Event schema not found', type: ProblemDetailsDto })
  async deleteSchema(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) schemaId: string,
  ): Promise<void> {
    await this.#eventSchemasService.deleteSchema(workspaceId, schemaId);
  }
}
