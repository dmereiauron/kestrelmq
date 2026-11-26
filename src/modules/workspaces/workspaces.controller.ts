import {
  Body,
  Controller,
  ForbiddenException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles, WorkspaceIdParam } from '../../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/interfaces/authenticated-request.interface.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto.js';
import { CreateApiKeyDto } from './dto/create-api-key.dto.js';
import { CreateWorkspaceDto } from './dto/create-workspace.dto.js';
import {
  type CreatedApiKeyResponse,
  type CreatedWorkspaceResponse,
  type WorkspaceMemberResponse,
  WorkspacesService,
} from './workspaces.service.js';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
@WorkspaceIdParam('id')
export class WorkspacesController {
  readonly #workspacesService: WorkspacesService;

  constructor(workspacesService: WorkspacesService) {
    this.#workspacesService = workspacesService;
  }

  @Post()
  async createWorkspace(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkspaceDto,
  ): Promise<CreatedWorkspaceResponse> {
    return this.#workspacesService.createWorkspace(user.userId, dto);
  }

  @Post(':id/members')
  @UseGuards(RolesGuard)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  async addMember(
    @Param('id', ParseUUIDPipe) workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: AddWorkspaceMemberDto,
  ): Promise<WorkspaceMemberResponse> {
    if (!req.memberRole) {
      throw new ForbiddenException('Missing verified workspace role');
    }
    return this.#workspacesService.addMember(workspaceId, req.memberRole, dto);
  }

  @Post(':id/api-keys')
  @UseGuards(RolesGuard)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  async createApiKey(
    @Param('id', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreatedApiKeyResponse> {
    return this.#workspacesService.createApiKey(workspaceId, dto);
  }
}
