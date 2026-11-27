import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import { CryptoService } from '../crypto/crypto.service.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RedisService } from '../redis/redis.service.js';
import { createMcpCallFixture } from '../../modules/mcp/testing/mcp-context.fixture.js';
import { ApiKeyGuard } from './api-key.guard.js';

function createHttpContext(headers: Record<string, string | string[] | undefined>): {
  context: ExecutionContext;
  request: AuthenticatedRequest;
} {
  const request = { headers } as unknown as AuthenticatedRequest;
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('ApiKeyGuard', () => {
  let cryptoService: CryptoService;
  let redisGetMock: ReturnType<typeof vi.fn>;
  let redisSetExMock: ReturnType<typeof vi.fn>;
  let findUniqueMock: ReturnType<typeof vi.fn>;
  let updateMock: ReturnType<typeof vi.fn>;
  let guard: ApiKeyGuard;

  beforeEach(() => {
    const masterKey = randomBytes(32).toString('hex');
    const configService = {
      get: () => masterKey,
    } as unknown as ConfigService<EnvConfig, true>;
    cryptoService = new CryptoService(configService);

    redisGetMock = vi.fn();
    redisSetExMock = vi.fn().mockResolvedValue(undefined);
    findUniqueMock = vi.fn();
    updateMock = vi.fn().mockResolvedValue({});

    const prismaService = {
      apiKey: {
        findUnique: findUniqueMock,
        update: updateMock,
      },
    } as unknown as PrismaService;

    const redisService = {
      get: redisGetMock,
      setEx: redisSetExMock,
    } as unknown as RedisService;

    guard = new ApiKeyGuard(prismaService, redisService, cryptoService);
  });

  it('serves active key from Redis cache hit (apikey:{hash}) without querying PostgreSQL', async () => {
    const rawKey = `kmq_live_${randomBytes(24).toString('hex')}`;
    const keyHash = cryptoService.hashSha256(rawKey);
    const keyId = randomUUID();
    const workspaceId = randomUUID();

    redisGetMock.mockResolvedValue(JSON.stringify({ id: keyId, workspaceId }));

    const { context, request } = createHttpContext({
      authorization: `Bearer ${rawKey}`,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(redisGetMock).toHaveBeenCalledWith(`apikey:${keyHash}`);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(request.apiKey).toEqual({ id: keyId, workspaceId });
    expect(request.workspaceId).toBe(workspaceId);
  });

  it('accepts x-api-key header, falls back to PostgreSQL on cache miss, and populates Redis with 300s TTL', async () => {
    const rawKey = `kmq_live_${randomBytes(24).toString('hex')}`;
    const keyHash = cryptoService.hashSha256(rawKey);
    const keyId = randomUUID();
    const workspaceId = randomUUID();

    redisGetMock.mockResolvedValue(null);
    findUniqueMock.mockResolvedValue({
      id: keyId,
      workspaceId,
      revokedAt: null,
    });

    const { context, request } = createHttpContext({
      'x-api-key': rawKey,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { keyHash },
      select: { id: true, workspaceId: true, revokedAt: true },
    });
    expect(redisSetExMock).toHaveBeenCalledWith(
      `apikey:${keyHash}`,
      300,
      JSON.stringify({ id: keyId, workspaceId }),
    );
    expect(updateMock).toHaveBeenCalledOnce();
    expect(request.apiKey).toEqual({ id: keyId, workspaceId });
    expect(request.workspaceId).toBe(workspaceId);
  });

  it('recovers gracefully when Redis contains malformed JSON and re-hydrates from PostgreSQL', async () => {
    const rawKey = `kmq_live_${randomBytes(24).toString('hex')}`;
    const keyId = randomUUID();
    const workspaceId = randomUUID();

    redisGetMock.mockResolvedValue('{corrupt-json');
    findUniqueMock.mockResolvedValue({
      id: keyId,
      workspaceId,
      revokedAt: null,
    });

    const { context } = createHttpContext({ 'x-api-key': [rawKey] });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findUniqueMock).toHaveBeenCalledOnce();
    expect(redisSetExMock).toHaveBeenCalledOnce();
  });

  it('rejects missing, non-prefixed, unknown, or revoked API keys with 401 Unauthorized', async () => {
    await expect(guard.canActivate(createHttpContext({}).context)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      guard.canActivate(createHttpContext({ 'x-api-key': 'kmq_live_' }).context),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(createHttpContext({ authorization: 'Bearer invalid_prefix_123' }).context),
    ).rejects.toThrow(UnauthorizedException);
    expect(redisGetMock).not.toHaveBeenCalled();

    const revokedKey = `kmq_live_${randomBytes(24).toString('hex')}`;
    redisGetMock.mockResolvedValue(null);
    findUniqueMock.mockResolvedValue({
      id: randomUUID(),
      workspaceId: randomUUID(),
      revokedAt: new Date(),
    });

    await expect(
      guard.canActivate(createHttpContext({ 'x-api-key': revokedKey }).context),
    ).rejects.toThrow(UnauthorizedException);
    expect(redisSetExMock).not.toHaveBeenCalled();
  });

  describe('MCP calls', () => {
    it('authenticates an MCP tool call from the underlying HTTP request headers', async () => {
      const rawKey = `kmq_live_${randomBytes(24).toString('hex')}`;
      const keyId = randomUUID();
      const workspaceId = randomUUID();
      redisGetMock.mockResolvedValue(JSON.stringify({ id: keyId, workspaceId }));

      const { executionContext, request } = createMcpCallFixture({
        name: 'send_event',
        request: { headers: { authorization: `Bearer ${rawKey}` } },
      });

      await expect(guard.canActivate(executionContext)).resolves.toBe(true);
      expect(redisGetMock).toHaveBeenCalledWith(`apikey:${cryptoService.hashSha256(rawKey)}`);
      expect(request.workspaceId).toBe(workspaceId);
      expect(request.apiKey).toEqual({ id: keyId, workspaceId });
    });

    it('skips a second lookup when the endpoint-level pass already resolved the same request', async () => {
      const workspaceId = randomUUID();
      const { executionContext } = createMcpCallFixture({
        request: { headers: {}, workspaceId, apiKey: { id: randomUUID(), workspaceId } },
      });

      await expect(guard.canActivate(executionContext)).resolves.toBe(true);
      expect(redisGetMock).not.toHaveBeenCalled();
      expect(findUniqueMock).not.toHaveBeenCalled();
    });

    it('does not trust a workspaceId on the request without a matching resolved API key', async () => {
      const { executionContext } = createMcpCallFixture({
        request: { headers: {}, workspaceId: randomUUID() },
      });

      await expect(guard.canActivate(executionContext)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a revoked key on an MCP call with 401', async () => {
      const rawKey = `kmq_live_${randomBytes(24).toString('hex')}`;
      redisGetMock.mockResolvedValue(null);
      findUniqueMock.mockResolvedValue({
        id: randomUUID(),
        workspaceId: randomUUID(),
        revokedAt: new Date(),
      });

      const { executionContext, request } = createMcpCallFixture({
        request: { headers: { 'x-api-key': rawKey } },
      });

      await expect(guard.canActivate(executionContext)).rejects.toThrow(UnauthorizedException);
      expect(request.workspaceId).toBeUndefined();
    });

    it('rejects MCP calls without an HTTP request (stdio)', async () => {
      const { executionContext, mcpContext } = createMcpCallFixture();
      Object.defineProperty(mcpContext, 'request', { value: undefined });

      await expect(guard.canActivate(executionContext)).rejects.toThrow(UnauthorizedException);
    });
  });
});
