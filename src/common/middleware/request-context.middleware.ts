import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';

const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const incomingHeader = req.headers['x-request-id'];
    const candidate = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;

    const requestId =
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate.length <= MAX_REQUEST_ID_LENGTH &&
      SAFE_REQUEST_ID_PATTERN.test(candidate)
        ? candidate
        : randomUUID();

    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
