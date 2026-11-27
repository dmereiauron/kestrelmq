import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { CreateInboundSourceDto } from './dto/create-inbound-source.dto.js';
import {
  InboundService,
  type InboundSourceResponse,
  type ResumeInboundSourceResponse,
} from './inbound.service.js';

@Controller('inbound-sources')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
export class InboundSourcesController {
  readonly #inboundService: InboundService;

  constructor(inboundService: InboundService) {
    this.#inboundService = inboundService;
  }

  @Post()
  async createSource(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: CreateInboundSourceDto,
  ): Promise<InboundSourceResponse> {
    return this.#inboundService.createSource(workspaceId, dto);
  }

  @Get()
  async listSources(
    @CurrentWorkspaceId() workspaceId: string,
  ): Promise<InboundSourceResponse[]> {
    return this.#inboundService.listSources(workspaceId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSource(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) sourceId: string,
  ): Promise<void> {
    await this.#inboundService.deleteSource(workspaceId, sourceId);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  async pauseSource(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) sourceId: string,
  ): Promise<InboundSourceResponse> {
    return this.#inboundService.pauseSource(workspaceId, sourceId);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  async resumeSource(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) sourceId: string,
  ): Promise<ResumeInboundSourceResponse> {
    return this.#inboundService.resumeSource(workspaceId, sourceId);
  }
}
