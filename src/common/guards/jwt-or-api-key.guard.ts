import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function hasApiKeyCredentials(request: AuthenticatedRequest): boolean {
  const headerKey = request.headers['x-api-key'];
  const candidateHeader = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  if (typeof candidateHeader === 'string' && candidateHeader.trim().length > 0) {
    return true;
  }

  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
    const match = BEARER_PATTERN.exec(authHeader.trim());
    if (match?.[1]?.startsWith(ApiKeyGuard.API_KEY_PREFIX)) {
      return true;
    }
  }

  return false;
}

@Injectable()
export class JwtOrApiKeyGuard implements CanActivate {
  readonly #apiKeyGuard: ApiKeyGuard;
  readonly #jwtAuthGuard: JwtAuthGuard;
  readonly #rolesGuard: RolesGuard;

  constructor(apiKeyGuard: ApiKeyGuard, jwtAuthGuard: JwtAuthGuard, rolesGuard: RolesGuard) {
    this.#apiKeyGuard = apiKeyGuard;
    this.#jwtAuthGuard = jwtAuthGuard;
    this.#rolesGuard = rolesGuard;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (hasApiKeyCredentials(request)) {
      return this.#apiKeyGuard.canActivate(context);
    }

    const jwtAuthenticated = await this.#jwtAuthGuard.canActivate(context);
    if (!jwtAuthenticated) {
      return false;
    }

    return this.#rolesGuard.canActivate(context);
  }
}
