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
import { CreateIntegrationDto } from './dto/create-integration.dto.js';
import { TestIntegrationDto } from './dto/test-integration.dto.js';
import {
  type IntegrationResponse,
  IntegrationsService,
  type TestIntegrationResponse,
} from './integrations.service.js';

@ApiTags('Integrations')
@ApiWorkspaceJwtAuth()
@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IntegrationsController {
  readonly #integrationsService: IntegrationsService;

  constructor(integrationsService: IntegrationsService) {
    this.#integrationsService = integrationsService;
  }

  @Post()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Create an external provider integration (AES-256-GCM encrypted)' })
  @ApiResponse({ status: 201, description: 'Integration created (credentials redacted)' })
  @ApiResponse({ status: 400, description: 'Invalid provider credentials', type: ProblemDetailsDto })
  async createIntegration(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: CreateIntegrationDto,
  ): Promise<IntegrationResponse> {
    return this.#integrationsService.createIntegration(workspaceId, dto);
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({ summary: 'List integrations in the workspace' })
  @ApiOkResponse({ description: 'List of workspace integrations' })
  async listIntegrations(
    @CurrentWorkspaceId() workspaceId: string,
  ): Promise<IntegrationResponse[]> {
    return this.#integrationsService.listIntegrations(workspaceId);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Send a live connectivity verification ping through the integration' })
  @ApiOkResponse({ description: 'Connectivity test succeeded' })
  @ApiResponse({ status: 404, description: 'Integration not found', type: ProblemDetailsDto })
  @ApiResponse({ status: 502, description: 'Upstream provider rejected ping', type: ProblemDetailsDto })
  async testIntegration(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) integrationId: string,
    @Body() dto: TestIntegrationDto,
  ): Promise<TestIntegrationResponse> {
    return this.#integrationsService.testIntegration(workspaceId, integrationId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Delete a workspace integration' })
  @ApiNoContentResponse({ description: 'Integration deleted' })
  @ApiResponse({ status: 404, description: 'Integration not found', type: ProblemDetailsDto })
  async deleteIntegration(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) integrationId: string,
  ): Promise<void> {
    await this.#integrationsService.deleteIntegration(workspaceId, integrationId);
  }
}
