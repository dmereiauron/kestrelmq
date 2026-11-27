import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';

export function extractCurrentWorkspaceId(context: ExecutionContext): string {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.workspaceId) {
    throw new BadRequestException('Verified workspace context is missing');
  }
  return request.workspaceId;
}

export const CurrentWorkspaceId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => extractCurrentWorkspaceId(ctx),
);
