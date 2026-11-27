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
import { CreateTemplateDto } from './dto/create-template.dto.js';
import { UpdateTemplateDto } from './dto/update-template.dto.js';
import { type TemplateResponse, TemplatesService } from './templates.service.js';

@ApiTags('Templates')
@ApiWorkspaceJwtAuth()
@Controller('templates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TemplatesController {
  readonly #templatesService: TemplatesService;

  constructor(templatesService: TemplatesService) {
    this.#templatesService = templatesService;
  }

  @Post()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Create a Handlebars notification template' })
  @ApiResponse({ status: 201, description: 'Template created' })
  @ApiResponse({ status: 400, description: 'Invalid Handlebars syntax', type: ProblemDetailsDto })
  async createTemplate(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: CreateTemplateDto,
  ): Promise<TemplateResponse> {
    return this.#templatesService.createTemplate(workspaceId, dto);
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({ summary: 'List workspace templates' })
  @ApiOkResponse({ description: 'List of templates' })
  async listTemplates(@CurrentWorkspaceId() workspaceId: string): Promise<TemplateResponse[]> {
    return this.#templatesService.listTemplates(workspaceId);
  }

  @Get(':id')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({ summary: 'Get template details by ID' })
  @ApiOkResponse({ description: 'Template record' })
  @ApiResponse({ status: 404, description: 'Template not found', type: ProblemDetailsDto })
  async getTemplate(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) templateId: string,
  ): Promise<TemplateResponse> {
    return this.#templatesService.getTemplate(workspaceId, templateId);
  }

  @Patch(':id')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Update an existing Handlebars template' })
  @ApiOkResponse({ description: 'Updated template' })
  @ApiResponse({ status: 404, description: 'Template not found', type: ProblemDetailsDto })
  async updateTemplate(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) templateId: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<TemplateResponse> {
    return this.#templatesService.updateTemplate(workspaceId, templateId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Delete a template' })
  @ApiNoContentResponse({ description: 'Template deleted' })
  @ApiResponse({ status: 404, description: 'Template not found', type: ProblemDetailsDto })
  async deleteTemplate(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) templateId: string,
  ): Promise<void> {
    await this.#templatesService.deleteTemplate(workspaceId, templateId);
  }
}
