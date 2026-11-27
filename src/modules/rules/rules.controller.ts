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
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
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
import { CreateRuleDto } from './dto/create-rule.dto.js';
import { UpdateRuleDto } from './dto/update-rule.dto.js';
import { type RoutingRuleResponse, RulesService } from './rules.service.js';

@ApiTags('Rules')
@ApiWorkspaceJwtAuth()
@Controller('rules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RulesController {
  readonly #rulesService: RulesService;

  constructor(rulesService: RulesService) {
    this.#rulesService = rulesService;
  }

  @Post()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Create an event-to-integration routing rule' })
  @ApiResponse({ status: 201, description: 'Routing rule created' })
  @ApiResponse({ status: 400, description: 'Invalid rule configuration', type: ProblemDetailsDto })
  async createRule(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: CreateRuleDto,
  ): Promise<RoutingRuleResponse> {
    return this.#rulesService.createRule(workspaceId, dto);
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({ summary: 'List routing rules in the workspace' })
  @ApiQuery({
    name: 'eventName',
    required: false,
    description: 'Optional exact event pattern filter',
  })
  @ApiOkResponse({ description: 'List of routing rules' })
  async listRules(
    @CurrentWorkspaceId() workspaceId: string,
    @Query('eventName') eventName?: string,
  ): Promise<RoutingRuleResponse[]> {
    return this.#rulesService.listRules(workspaceId, eventName);
  }

  @Patch(':id')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Update a routing rule' })
  @ApiOkResponse({ description: 'Updated routing rule' })
  @ApiResponse({ status: 404, description: 'Routing rule not found', type: ProblemDetailsDto })
  async updateRule(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) ruleId: string,
    @Body() dto: UpdateRuleDto,
  ): Promise<RoutingRuleResponse> {
    return this.#rulesService.updateRule(workspaceId, ruleId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Delete a routing rule' })
  @ApiNoContentResponse({ description: 'Routing rule deleted' })
  @ApiResponse({ status: 404, description: 'Routing rule not found', type: ProblemDetailsDto })
  async deleteRule(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) ruleId: string,
  ): Promise<void> {
    await this.#rulesService.deleteRule(workspaceId, ruleId);
  }
}
