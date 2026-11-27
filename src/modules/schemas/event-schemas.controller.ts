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
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { InferSchemaDto } from './dto/infer-schema.dto.js';
import { UpdateEventSchemaDto } from './dto/update-event-schema.dto.js';
import { UpsertEventSchemaDto } from './dto/upsert-event-schema.dto.js';
import {
  type EventSchemaResponse,
  EventSchemasService,
  type InferSchemaResponse,
} from './event-schemas.service.js';

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
  inferSchema(@Body() dto: InferSchemaDto): InferSchemaResponse {
    return this.#eventSchemasService.inferFromSample(dto.samplePayload);
  }

  @Post()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  async upsertSchema(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: UpsertEventSchemaDto,
  ): Promise<EventSchemaResponse> {
    return this.#eventSchemasService.upsertSchema(workspaceId, dto);
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  async listSchemas(@CurrentWorkspaceId() workspaceId: string): Promise<EventSchemaResponse[]> {
    return this.#eventSchemasService.listSchemas(workspaceId);
  }

  @Patch(':id')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
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
  async deleteSchema(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) schemaId: string,
  ): Promise<void> {
    await this.#eventSchemasService.deleteSchema(workspaceId, schemaId);
  }
}
