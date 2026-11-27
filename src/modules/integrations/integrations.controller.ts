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
import { CreateIntegrationDto } from './dto/create-integration.dto.js';
import { TestIntegrationDto } from './dto/test-integration.dto.js';
import {
  type IntegrationResponse,
  IntegrationsService,
  type TestIntegrationResponse,
} from './integrations.service.js';

@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IntegrationsController {
  readonly #integrationsService: IntegrationsService;

  constructor(integrationsService: IntegrationsService) {
    this.#integrationsService = integrationsService;
  }

  @Post()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  async createIntegration(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: CreateIntegrationDto,
  ): Promise<IntegrationResponse> {
    return this.#integrationsService.createIntegration(workspaceId, dto);
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  async listIntegrations(
    @CurrentWorkspaceId() workspaceId: string,
  ): Promise<IntegrationResponse[]> {
    return this.#integrationsService.listIntegrations(workspaceId);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
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
  async deleteIntegration(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) integrationId: string,
  ): Promise<void> {
    await this.#integrationsService.deleteIntegration(workspaceId, integrationId);
  }
}
