import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { catchError, from, type Observable, of, switchMap, throwError } from 'rxjs';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import { RedisService } from '../redis/redis.service.js';

const IDEMPOTENCY_TTL_SECONDS = 86_400;
const PROCESSING_PREFIX = 'PROCESSING:';
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

interface CachedHttpIdempotencyRecord {
  readonly statusCode: number;
  readonly body: unknown;
}

function parseCachedRecord(raw: string): CachedHttpIdempotencyRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['statusCode'] === 'number' &&
      'body' in parsed
    ) {
      return {
        statusCode: (parsed as Record<string, number>)['statusCode'],
        body: (parsed as Record<string, unknown>)['body'],
      };
    }
    return null;
  } catch {
    return null;
  }
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  static readonly TTL_SECONDS = IDEMPOTENCY_TTL_SECONDS;

  readonly #redisService: RedisService;

  constructor(redisService: RedisService) {
    this.#redisService = redisService;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const rawHeader = request.headers['idempotency-key'];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (headerValue === undefined) {
      return next.handle();
    }

    const trimmedKey = headerValue.trim();
    if (trimmedKey.length === 0 || trimmedKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException(
        `Idempotency-Key must be between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} non-whitespace characters`,
      );
    }

    const scope = request.workspaceId ?? 'global';
    const routePath = request.originalUrl || request.url || '/';
    const redisKey = `idempotency:http:${scope}:${request.method}:${routePath}:${trimmedKey}`;
    const lockToken = `${PROCESSING_PREFIX}${randomUUID()}`;

    return from(this.#acquireOrReplay(redisKey, lockToken)).pipe(
      switchMap((existing) => {
        if (existing !== null) {
          response.status(HttpStatus.OK);
          response.setHeader('X-Idempotency-Replayed', 'true');
          return of(existing.body);
        }

        return next.handle().pipe(
          switchMap((body: unknown) =>
            from(this.#persistResponse(redisKey, response.statusCode, body)).pipe(
              switchMap(() => of(body)),
            ),
          ),
          catchError((err: unknown) =>
            from(this.releaseLockOnError(redisKey, lockToken)).pipe(
              switchMap(() => throwError(() => err)),
            ),
          ),
        );
      }),
    );
  }

  async releaseLockOnError(redisKey: string, lockToken: string): Promise<void> {
    await this.#redisService.compareAndDel(redisKey, lockToken);
  }

  async #acquireOrReplay(
    redisKey: string,
    lockToken: string,
  ): Promise<CachedHttpIdempotencyRecord | null> {
    const acquired = await this.#redisService.setNxEx(
      redisKey,
      IDEMPOTENCY_TTL_SECONDS,
      lockToken,
    );

    if (acquired) {
      return null;
    }

    const existingRaw = await this.#redisService.get(redisKey);
    if (existingRaw === null || existingRaw.startsWith(PROCESSING_PREFIX)) {
      throw new ConflictException(
        'An identical request with this Idempotency-Key is currently being processed',
      );
    }

    const parsed = parseCachedRecord(existingRaw);
    if (parsed === null) {
      throw new ConflictException(
        'An identical request with this Idempotency-Key is currently being processed',
      );
    }

    return parsed;
  }

  async #persistResponse(redisKey: string, statusCode: number, body: unknown): Promise<void> {
    const payload: CachedHttpIdempotencyRecord = { statusCode, body };
    await this.#redisService.setEx(
      redisKey,
      IDEMPOTENCY_TTL_SECONDS,
      JSON.stringify(payload),
    );
  }
}
