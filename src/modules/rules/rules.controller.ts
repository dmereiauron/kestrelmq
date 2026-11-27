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
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { CreateRuleDto } from './dto/create-rule.dto.js';
import { UpdateRuleDto } from './dto/update-rule.dto.js';
import { type RoutingRuleResponse, RulesService } from './rules.service.js';

@Controller('rules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RulesController {
  readonly #rulesService: RulesService;

  constructor(rulesService: RulesService) {
    this.#rulesService = rulesService;
  }

  @Post()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  async createRule(
    @CurrentWorkspaceId() workspaceId: string,
    @Body() dto: CreateRuleDto,
  ): Promise<RoutingRuleResponse> {
    return this.#rulesService.createRule(workspaceId, dto);
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  async listRules(
    @CurrentWorkspaceId() workspaceId: string,
    @Query('eventName') eventName?: string,
  ): Promise<RoutingRuleResponse[]> {
    return this.#rulesService.listRules(workspaceId, eventName);
  }

  @Patch(':id')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
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
  async deleteRule(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) ruleId: string,
  ): Promise<void> {
    await this.#rulesService.deleteRule(workspaceId, ruleId);
  }
}
