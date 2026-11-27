import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { resolveMcpWorkspaceId } from './mcp-workspace.util.js';
import { createMcpCallFixture, createWorkspaceMcpContext } from './testing/mcp-context.fixture.js';

describe('resolveMcpWorkspaceId', () => {
  it('returns the workspaceId resolved by ApiKeyGuard on the underlying request', () => {
    expect(resolveMcpWorkspaceId(createWorkspaceMcpContext('ws-a'))).toBe('ws-a');
  });

  it('throws 401 when no verified workspace is attached', () => {
    expect(() => resolveMcpWorkspaceId(createMcpCallFixture().mcpContext)).toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 when the call has no HTTP request (stdio)', () => {
    const { mcpContext } = createMcpCallFixture();
    Object.defineProperty(mcpContext, 'request', { value: undefined });
    expect(() => resolveMcpWorkspaceId(mcpContext)).toThrow(UnauthorizedException);
  });
});
