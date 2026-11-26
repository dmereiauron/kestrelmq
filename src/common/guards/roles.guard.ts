import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { ROLES_KEY, WORKSPACE_ID_PARAM_KEY } from '../decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import { PrismaService } from '../prisma/prisma.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLE_WEIGHT: Readonly<Record<WorkspaceRole, number>> = {
  [WorkspaceRole.OWNER]: 3,
  [WorkspaceRole.ADMIN]: 2,
  [WorkspaceRole.VIEWER]: 1,
};

function readStringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) {
    return value[0].trim();
  }
  return undefined;
}

@Injectable()
export class RolesGuard implements CanActivate {
  readonly #reflector: Reflector;
  readonly #prismaService: PrismaService;

  constructor(reflector: Reflector, prismaService: PrismaService) {
    this.#reflector = reflector;
    this.#prismaService = prismaService;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.#reflector.getAllAndOverride<readonly WorkspaceRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.userId) {
      throw new UnauthorizedException('Authenticated user context is required');
    }

    const customParamName = this.#reflector.getAllAndOverride<string | undefined>(
      WORKSPACE_ID_PARAM_KEY,
      [context.getHandler(), context.getClass()],
    );

    const workspaceId = this.#resolveWorkspaceId(request, customParamName);
    if (!workspaceId || !UUID_PATTERN.test(workspaceId)) {
      throw new BadRequestException('A valid workspace UUID is required');
    }

    const membership = await this.#prismaService.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: request.user.userId,
        },
      },
      select: { role: true },
    });

    const minRequiredWeight = Math.min(...requiredRoles.map((role) => ROLE_WEIGHT[role]));

    if (!membership || ROLE_WEIGHT[membership.role] < minRequiredWeight) {
      throw new ForbiddenException('Insufficient workspace permissions');
    }

    request.workspaceId = workspaceId;
    request.memberRole = membership.role;

    return true;
  }

  #resolveWorkspaceId(
    request: AuthenticatedRequest,
    customParamName?: string,
  ): string | undefined {
    const params = request.params as Record<string, unknown> | undefined;
    if (customParamName && params) {
      const fromCustomParam = readStringValue(params[customParamName]);
      if (fromCustomParam) {
        return fromCustomParam;
      }
    }

    const fromWorkspaceIdParam = params ? readStringValue(params['workspaceId']) : undefined;
    if (fromWorkspaceIdParam) {
      return fromWorkspaceIdParam;
    }

    const fromHeader = readStringValue(request.headers['x-workspace-id']);
    if (fromHeader) {
      return fromHeader;
    }

    const bodyRecord =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : undefined;
    const fromBody = bodyRecord ? readStringValue(bodyRecord['workspaceId']) : undefined;
    if (fromBody) {
      return fromBody;
    }

    const queryRecord =
      typeof request.query === 'object' && request.query !== null
        ? (request.query as Record<string, unknown>)
        : undefined;
    const fromQuery = queryRecord ? readStringValue(queryRecord['workspaceId']) : undefined;
    if (fromQuery) {
      return fromQuery;
    }

    return params ? readStringValue(params['id']) : undefined;
  }
}
