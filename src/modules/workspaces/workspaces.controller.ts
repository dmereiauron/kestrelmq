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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles, WorkspaceIdParam } from '../../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/interfaces/authenticated-request.interface.js';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/api-workspace-header.decorator.js';
import { ProblemDetailsDto } from '../../common/swagger/problem-details.dto.js';
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

@ApiTags('Workspaces')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('workspaces')
@UseGuards(JwtAuthGuard)
@WorkspaceIdParam('id')
export class WorkspacesController {
  readonly #workspacesService: WorkspacesService;

  constructor(workspacesService: WorkspacesService) {
    this.#workspacesService = workspacesService;
  }

  @Post()
  @ApiOperation({ summary: 'Create an isolated multi-tenant workspace (creator becomes OWNER)' })
  @ApiResponse({ status: 201, description: 'Workspace created with signing secret' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ProblemDetailsDto })
  @ApiResponse({ status: 401, description: 'Unauthorized', type: ProblemDetailsDto })
  @ApiResponse({ status: 409, description: 'Slug already in use', type: ProblemDetailsDto })
  async createWorkspace(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkspaceDto,
  ): Promise<CreatedWorkspaceResponse> {
    return this.#workspacesService.createWorkspace(user.userId, dto);
  }

  @Post(':id/members')
  @UseGuards(RolesGuard)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Assign a user to the workspace with an RBAC role' })
  @ApiResponse({ status: 201, description: 'Member added to workspace' })
  @ApiResponse({ status: 403, description: 'Forbidden', type: ProblemDetailsDto })
  @ApiResponse({ status: 404, description: 'Target user not found', type: ProblemDetailsDto })
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
  @ApiOperation({ summary: 'Generate a new workspace API key (kmq_live_...)' })
  @ApiResponse({
    status: 201,
    description: 'API key generated (plaintext returned once; SHA-256 hash stored)',
  })
  @ApiResponse({ status: 403, description: 'Forbidden', type: ProblemDetailsDto })
  async createApiKey(
    @Param('id', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreatedApiKeyResponse> {
    return this.#workspacesService.createApiKey(workspaceId, dto);
  }
}
