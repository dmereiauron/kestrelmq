import { UnauthorizedException } from '@nestjs/common';
import type { McpContext } from '@nestjs/mcp';
import type { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface.js';

export type KestrelMcpContext = McpContext<AuthenticatedRequest>;

/**
 * Returns the tenant scope of an MCP call: the `workspaceId` that `ApiKeyGuard` resolved from the verified
 * `kmq_live_...` API key and attached to the underlying HTTP request.
 *
 * This is the only source of tenant scope for MCP tools and resources. Tool input schemas never accept a
 * `workspaceId` argument, so a client cannot widen or switch its scope.
 */
export function resolveMcpWorkspaceId(ctx: KestrelMcpContext): string {
  const workspaceId = ctx.request?.workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new UnauthorizedException('Verified workspace context is missing for this MCP call');
  }
  return workspaceId;
}
