import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { WorkspaceRole } from '../../generated/prisma/enums.js';

export const ROLES_KEY = 'kestrelmq:roles';
export const WORKSPACE_ID_PARAM_KEY = 'kestrelmq:workspace_id_param';

export const Roles = (...roles: WorkspaceRole[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);

export const WorkspaceIdParam = (paramName: string): CustomDecorator<string> =>
  SetMetadata(WORKSPACE_ID_PARAM_KEY, paramName);
