import {
  BadRequestException,
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { ROLES_KEY, WORKSPACE_ID_PARAM_KEY } from '../decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RolesGuard } from './roles.guard.js';

function buildContext(options: {
  userId?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): { context: ExecutionContext; request: AuthenticatedRequest } {
  const request = {
    user: options.userId
      ? { userId: options.userId, email: 'member@kestrelmq.io', sessionId: randomUUID() }
      : undefined,
    params: options.params ?? {},
    headers: options.headers ?? {},
    body: options.body ?? {},
    query: options.query ?? {},
  } as unknown as AuthenticatedRequest;

  const handler = (): void => {};
  class DummyController {}

  const context = {
    getHandler: () => handler,
    getClass: () => DummyController,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;

  return { context, request };
}

describe('RolesGuard', () => {
  let getAllAndOverrideMock: ReturnType<typeof vi.fn>;
  let findUniqueMemberMock: ReturnType<typeof vi.fn>;
  let guard: RolesGuard;

  beforeEach(() => {
    getAllAndOverrideMock = vi.fn();
    findUniqueMemberMock = vi.fn();

    const reflector = {
      getAllAndOverride: getAllAndOverrideMock,
    } as unknown as Reflector;

    const prismaService = {
      workspaceMember: {
        findUnique: findUniqueMemberMock,
      },
    } as unknown as PrismaService;

    guard = new RolesGuard(reflector, prismaService);
  });

  it('allows access immediately when no @Roles() metadata is defined', async () => {
    getAllAndOverrideMock.mockReturnValue(undefined);
    const { context } = buildContext({});

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findUniqueMemberMock).not.toHaveBeenCalled();
  });

  it('enforces OWNER > ADMIN > VIEWER hierarchy and populates workspaceId + memberRole', async () => {
    const userId = randomUUID();
    const workspaceId = randomUUID();

    getAllAndOverrideMock.mockImplementation((key: string) => {
      if (key === ROLES_KEY) return [WorkspaceRole.ADMIN];
      if (key === WORKSPACE_ID_PARAM_KEY) return 'id';
      return undefined;
    });

    // OWNER satisfies @Roles(ADMIN)
    findUniqueMemberMock.mockResolvedValueOnce({ role: WorkspaceRole.OWNER });
    const ownerCall = buildContext({ userId, params: { id: workspaceId } });
    await expect(guard.canActivate(ownerCall.context)).resolves.toBe(true);
    expect(ownerCall.request.workspaceId).toBe(workspaceId);
    expect(ownerCall.request.memberRole).toBe(WorkspaceRole.OWNER);

    // ADMIN satisfies @Roles(ADMIN)
    findUniqueMemberMock.mockResolvedValueOnce({ role: WorkspaceRole.ADMIN });
    const adminCall = buildContext({ userId, params: { id: workspaceId } });
    await expect(guard.canActivate(adminCall.context)).resolves.toBe(true);
    expect(adminCall.request.memberRole).toBe(WorkspaceRole.ADMIN);

    // VIEWER is rejected on @Roles(ADMIN) with 403 Forbidden
    findUniqueMemberMock.mockResolvedValueOnce({ role: WorkspaceRole.VIEWER });
    const viewerCall = buildContext({ userId, params: { id: workspaceId } });
    await expect(guard.canActivate(viewerCall.context)).rejects.toThrow(ForbiddenException);

    // Non-member is rejected with 403 Forbidden
    findUniqueMemberMock.mockResolvedValueOnce(null);
    const outsiderCall = buildContext({ userId, params: { id: workspaceId } });
    await expect(guard.canActivate(outsiderCall.context)).rejects.toThrow(ForbiddenException);
  });

  it('resolves workspaceId from headers, body, and query and rejects missing user or invalid UUID', async () => {
    getAllAndOverrideMock.mockImplementation((key: string) =>
      key === ROLES_KEY ? [WorkspaceRole.VIEWER] : undefined,
    );

    // Missing authenticated user -> 401
    await expect(
      guard.canActivate(buildContext({ params: { workspaceId: randomUUID() } }).context),
    ).rejects.toThrow(UnauthorizedException);

    // Invalid UUID -> 400
    await expect(
      guard.canActivate(
        buildContext({ userId: randomUUID(), params: { workspaceId: 'not-a-uuid' } }).context,
      ),
    ).rejects.toThrow(BadRequestException);

    // Header resolution (`x-workspace-id`)
    const wsId = randomUUID();
    findUniqueMemberMock.mockResolvedValue({ role: WorkspaceRole.VIEWER });
    const headerCtx = buildContext({
      userId: randomUUID(),
      headers: { 'x-workspace-id': wsId },
    });
    await expect(guard.canActivate(headerCtx.context)).resolves.toBe(true);
    expect(headerCtx.request.workspaceId).toBe(wsId);

    // Body and query resolution
    const bodyWsId = randomUUID();
    const bodyCtx = buildContext({
      userId: randomUUID(),
      body: { workspaceId: bodyWsId },
    });
    await expect(guard.canActivate(bodyCtx.context)).resolves.toBe(true);
    expect(bodyCtx.request.workspaceId).toBe(bodyWsId);

    const queryWsId = randomUUID();
    const queryCtx = buildContext({
      userId: randomUUID(),
      query: { workspaceId: queryWsId },
    });
    await expect(guard.canActivate(queryCtx.context)).resolves.toBe(true);
    expect(queryCtx.request.workspaceId).toBe(queryWsId);

    // Resource :id route without @WorkspaceIdParam('id') must NOT mistake params.id for workspaceId -> 400
    const resourceIdCtx = buildContext({
      userId: randomUUID(),
      params: { id: randomUUID() },
    });
    await expect(guard.canActivate(resourceIdCtx.context)).rejects.toThrow(BadRequestException);
  });
});
