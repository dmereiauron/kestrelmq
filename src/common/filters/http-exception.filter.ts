import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { McpExecutionContext, type McpContextType } from '@nestjs/mcp';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import { maskSensitiveData } from '../utils/mask-sensitive.util.js';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly timestamp: string;
  readonly errors?: readonly string[];
}

interface StatusDescriptor {
  readonly slug: string;
  readonly title: string;
}

const STATUS_DESCRIPTORS: Readonly<Record<number, StatusDescriptor>> = {
  [HttpStatus.BAD_REQUEST]: { slug: 'bad-request', title: 'Bad Request' },
  [HttpStatus.UNAUTHORIZED]: { slug: 'unauthorized', title: 'Unauthorized' },
  [HttpStatus.FORBIDDEN]: { slug: 'forbidden', title: 'Forbidden' },
  [HttpStatus.NOT_FOUND]: { slug: 'not-found', title: 'Not Found' },
  [HttpStatus.METHOD_NOT_ALLOWED]: { slug: 'method-not-allowed', title: 'Method Not Allowed' },
  [HttpStatus.CONFLICT]: { slug: 'conflict', title: 'Conflict' },
  [HttpStatus.PAYLOAD_TOO_LARGE]: { slug: 'payload-too-large', title: 'Payload Too Large' },
  [HttpStatus.UNPROCESSABLE_ENTITY]: {
    slug: 'unprocessable-content',
    title: 'Unprocessable Content',
  },
  [HttpStatus.TOO_MANY_REQUESTS]: { slug: 'too-many-requests', title: 'Too Many Requests' },
  [HttpStatus.INTERNAL_SERVER_ERROR]: {
    slug: 'internal-server-error',
    title: 'Internal Server Error',
  },
  [HttpStatus.BAD_GATEWAY]: { slug: 'bad-gateway', title: 'Bad Gateway' },
  [HttpStatus.SERVICE_UNAVAILABLE]: { slug: 'service-unavailable', title: 'Service Unavailable' },
};

const PROBLEM_TYPE_BASE_URI = 'https://errors.kestrelmq.io';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  readonly #logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType<McpContextType | 'http'>() === 'mcp') {
      this.#rethrowForMcp(exception, host);
    }

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<AuthenticatedRequest>();
    const response = ctx.getResponse<Response>();

    const instance = request.originalUrl || request.url || '/';
    const timestamp = new Date().toISOString();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = 'An unexpected internal server error occurred';
    let validationErrors: readonly string[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const rawResponse = exception.getResponse();

      if (typeof rawResponse === 'string') {
        detail = rawResponse;
      } else if (typeof rawResponse === 'object' && rawResponse !== null) {
        const messageField = (rawResponse as Record<string, unknown>)['message'];
        if (Array.isArray(messageField)) {
          const messages = messageField.filter((item): item is string => typeof item === 'string');
          validationErrors = messages;
          detail = messages.length > 0 ? messages.join('; ') : exception.message;
        } else if (typeof messageField === 'string' && messageField.length > 0) {
          detail = messageField;
        } else {
          detail = exception.message;
        }
      } else {
        detail = exception.message;
      }
    } else {
      this.#logger.error(
        JSON.stringify({
          message: 'Unhandled exception caught by HttpExceptionFilter',
          instance,
          requestId: request.requestId,
          error: maskSensitiveData(exception, { maskPii: true }),
        }),
      );
    }

    const descriptor = STATUS_DESCRIPTORS[status];
    const type = descriptor ? `${PROBLEM_TYPE_BASE_URI}/${descriptor.slug}` : 'about:blank';
    const title = descriptor ? descriptor.title : 'HTTP Error';

    const problem: ProblemDetails = {
      type,
      title,
      status,
      detail,
      instance,
      timestamp,
      ...(validationErrors !== undefined && validationErrors.length > 0
        ? { errors: validationErrors }
        : {}),
    };

    response.status(status).type('application/problem+json').json(problem);
  }

  /**
   * MCP tool/resource calls carry no HTTP response to write: `@nestjs/mcp` turns what the filter rethrows into a
   * tool result with `isError: true` (an `HttpException` keeps its message) or a JSON-RPC error (resources), so
   * writing problem+json here would corrupt the JSON-RPC stream. Unexpected errors are logged masked first.
   */
  #rethrowForMcp(exception: unknown, host: ArgumentsHost): never {
    if (!(exception instanceof HttpException)) {
      const mcp = McpExecutionContext.create(host);
      this.#logger.error(
        JSON.stringify({
          message: 'Unhandled exception in MCP call',
          kind: mcp.getKind(),
          name: mcp.getName(),
          requestId: mcp.getRequest<AuthenticatedRequest>()?.requestId,
          error: maskSensitiveData(exception, { maskPii: true }),
        }),
      );
    }
    throw exception;
  }
}
