import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { performance } from 'node:perf_hooks';
import { type Observable, tap } from 'rxjs';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import { maskSensitiveData } from '../utils/mask-sensitive.util.js';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  readonly #logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const startMs = performance.now();
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const method = request.method;
    const url = request.originalUrl || request.url;
    const requestId = request.requestId;
    const maskedHeaders = maskSensitiveData(request.headers);
    const maskedQuery = maskSensitiveData(request.query);
    const maskedBody = maskSensitiveData(request.body);

    return next.handle().pipe(
      tap({
        next: (responseBody: unknown): void => {
          const durationMs = Math.round((performance.now() - startMs) * 100) / 100;
          this.#logger.log(
            JSON.stringify({
              requestId,
              method,
              url,
              statusCode: response.statusCode,
              durationMs,
              headers: maskedHeaders,
              query: maskedQuery,
              body: maskedBody,
              response: maskSensitiveData(responseBody),
            }),
          );
        },
        error: (error: unknown): void => {
          const durationMs = Math.round((performance.now() - startMs) * 100) / 100;
          const statusCode =
            error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

          this.#logger.warn(
            JSON.stringify({
              requestId,
              method,
              url,
              statusCode,
              durationMs,
              headers: maskedHeaders,
              query: maskedQuery,
              body: maskedBody,
              error: maskSensitiveData(error),
            }),
          );
        },
      }),
    );
  }
}
