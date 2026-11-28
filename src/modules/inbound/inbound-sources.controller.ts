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
import { CreateInboundSourceDto } from './dto/create-inbound-source.dto.js';
import {
  InboundService,
  type InboundSourceResponse,
  type ResumeInboundSourceResponse,
} from './inbound.service.js';

@ApiTags('Inbound Sources')
@ApiWorkspaceJwtAuth()
@Controller('inbound-sources')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
export class InboundSourcesController {
  readonly #inboundService: InboundService;

  constructor(inboundService: InboundService) {
    this.#inboundService = inboundService;
  }

  @Post()
  @ApiOperation({ summary: 'Create a rate-limited, pauseable inbound webhook source' })
  @ApiResponse({ status: 201, description: 'Inbound source created' })
  @ApiResponse({ status: 400, description: 'Invalid configuration', type: ProblemDetailsDto })
  @ApiResponse({ status: 409, description: 'Source slug already in use', type: ProblemDetailsDto })
  async createSource(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: CreateInboundSourceDto,
  ): Promise<InboundSourceResponse> {
    return this.#inboundService.createSource(workspaceId, dto);
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({ summary: 'List inbound webhook sources in the workspace' })
  @ApiOkResponse({ description: 'List of inbound sources' })
  async listSources(
    @CurrentWorkspaceId() workspaceId: string,
  ): Promise<InboundSourceResponse[]> {
    return this.#inboundService.listSources(workspaceId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an inbound webhook source' })
  @ApiNoContentResponse({ description: 'Inbound source deleted' })
  @ApiResponse({ status: 404, description: 'Inbound source not found', type: ProblemDetailsDto })
  async deleteSource(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) sourceId: string,
  ): Promise<void> {
    await this.#inboundService.deleteSource(workspaceId, sourceId);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pause downstream webhook forwarding and buffer incoming webhooks as PAUSED',
  })
  @ApiOkResponse({ description: 'Inbound source paused' })
  @ApiResponse({ status: 404, description: 'Inbound source not found', type: ProblemDetailsDto })
  async pauseSource(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) sourceId: string,
  ): Promise<InboundSourceResponse> {
    return this.#inboundService.pauseSource(workspaceId, sourceId);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume forwarding and smoothly drain buffered PAUSED webhooks at maxRatePerSec',
  })
  @ApiOkResponse({ description: 'Inbound source resumed and buffered deliveries scheduled' })
  @ApiResponse({ status: 404, description: 'Inbound source not found', type: ProblemDetailsDto })
  async resumeSource(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) sourceId: string,
  ): Promise<ResumeInboundSourceResponse> {
    return this.#inboundService.resumeSource(workspaceId, sourceId);
  }
}
