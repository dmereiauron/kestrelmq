import type { Request } from 'express';
import type { WorkspaceRole } from '../../generated/prisma/enums.js';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
}

export interface AuthenticatedApiKey {
  readonly id: string;
  readonly workspaceId: string;
}

export interface AuthenticatedRequest extends Request {
  requestId?: string;
  user?: AuthenticatedUser;
  apiKey?: AuthenticatedApiKey;
  workspaceId?: string;
  memberRole?: WorkspaceRole;
}
