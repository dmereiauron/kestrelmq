import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { McpExecutionContext, type McpContextType } from '@nestjs/mcp';
import { CryptoService } from '../crypto/crypto.service.js';
import type {
  AuthenticatedApiKey,
  AuthenticatedRequest,
} from '../interfaces/authenticated-request.interface.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function parseCachedApiKey(raw: string): AuthenticatedApiKey | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['id'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['workspaceId'] === 'string'
    ) {
      return {
        id: (parsed as Record<string, string>)['id'],
        workspaceId: (parsed as Record<string, string>)['workspaceId'],
      };
    }
    return null;
  } catch {
    return null;
  }
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  static readonly API_KEY_PREFIX = 'kmq_live_' as const;
  static readonly CACHE_TTL_SEC = 300;

  readonly #prismaService: PrismaService;
  readonly #redisService: RedisService;
  readonly #cryptoService: CryptoService;

  constructor(
    prismaService: PrismaService,
    redisService: RedisService,
    cryptoService: CryptoService,
  ) {
    this.#prismaService = prismaService;
    this.#redisService = redisService;
    this.#cryptoService = cryptoService;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isMcpCall = context.getType<McpContextType | 'http'>() === 'mcp';
    const request = this.#resolveRequest(context, isMcpCall);

    // A call-level check on an MCP tool/resource whose HTTP request already passed the endpoint-level guard.
    if (isMcpCall && request.apiKey !== undefined && request.workspaceId === request.apiKey.workspaceId) {
      return true;
    }

    const rawKey = this.#extractRawKey(request);

    if (
      !rawKey ||
      !rawKey.startsWith(ApiKeyGuard.API_KEY_PREFIX) ||
      rawKey.length <= ApiKeyGuard.API_KEY_PREFIX.length
    ) {
      throw new UnauthorizedException('Missing or invalid API key');
    }

    const keyHash = this.#cryptoService.hashSha256(rawKey);
    const cacheKey = `apikey:${keyHash}`;

    const cachedRaw = await this.#redisService.get(cacheKey);
    if (cachedRaw !== null) {
      const cached = parseCachedApiKey(cachedRaw);
      if (cached !== null) {
        request.apiKey = cached;
        request.workspaceId = cached.workspaceId;
        return true;
      }
    }

    const record = await this.#prismaService.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        workspaceId: true,
        revokedAt: true,
      },
    });

    if (!record || record.revokedAt !== null) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    const metadata: AuthenticatedApiKey = {
      id: record.id,
      workspaceId: record.workspaceId,
    };

    await Promise.all([
      this.#redisService.setEx(cacheKey, ApiKeyGuard.CACHE_TTL_SEC, JSON.stringify(metadata)),
      this.#prismaService.apiKey.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      }),
    ]);

    request.apiKey = metadata;
    request.workspaceId = metadata.workspaceId;

    return true;
  }

  #resolveRequest(context: ExecutionContext, isMcpCall: boolean): AuthenticatedRequest {
    if (!isMcpCall) {
      return context.switchToHttp().getRequest<AuthenticatedRequest>();
    }
    const request = McpExecutionContext.create(context).getRequest<AuthenticatedRequest>();
    if (request === undefined) {
      throw new UnauthorizedException('API key authentication requires the HTTP transport');
    }
    return request;
  }

  #extractRawKey(request: AuthenticatedRequest): string | undefined {
    const authHeader = request.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
      const match = BEARER_PATTERN.exec(authHeader.trim());
      if (match?.[1]) {
        return match[1];
      }
    }

    const headerKey = request.headers['x-api-key'];
    const candidate = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }

    return undefined;
  }
}
