import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../interfaces/authenticated-request.interface.js';

export function extractCurrentUser(context: ExecutionContext): AuthenticatedUser {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.user) {
    throw new UnauthorizedException('Authenticated user context is missing');
  }
  return request.user;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => extractCurrentUser(ctx),
);
