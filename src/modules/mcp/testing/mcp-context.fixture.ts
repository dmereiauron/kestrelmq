import type { ExecutionContext } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import type { McpCallKind } from '@nestjs/mcp';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { AuthenticatedRequest } from '../../../common/interfaces/authenticated-request.interface.js';
import type { KestrelMcpContext } from '../mcp-workspace.util.js';

export interface McpCallFixtureOptions {
  readonly kind?: McpCallKind;
  readonly name?: string;
  readonly input?: unknown;
  readonly request?: Partial<AuthenticatedRequest>;
}

export interface McpCallFixture {
  readonly mcpContext: KestrelMcpContext;
  readonly executionContext: ExecutionContext;
  readonly request: AuthenticatedRequest;
}

/** Builds the `(input, McpContext)` pair `@nestjs/mcp` hands to methods and enhancers, for unit tests. */
export function createMcpCallFixture(options: McpCallFixtureOptions = {}): McpCallFixture {
  const request = {
    method: 'POST',
    url: '/mcp',
    headers: {},
    ...options.request,
  } as AuthenticatedRequest;

  const mcpContext: KestrelMcpContext = {
    kind: options.kind ?? 'tool',
    name: options.name ?? 'test_tool',
    transport: 'http',
    era: 'modern',
    request,
    signal: new AbortController().signal,
    server: {} as ServerContext,
    reportProgress: async (): Promise<void> => {},
  };

  const host = new ExecutionContextHost([options.input ?? {}, mcpContext]);
  host.setType('mcp');

  return { mcpContext, executionContext: host, request };
}

/** A fixture whose request already carries the workspace resolved by `ApiKeyGuard`. */
export function createWorkspaceMcpContext(workspaceId: string, name = 'test_tool'): KestrelMcpContext {
  return createMcpCallFixture({
    name,
    request: { workspaceId, apiKey: { id: `key-${workspaceId}`, workspaceId } },
  }).mcpContext;
}
