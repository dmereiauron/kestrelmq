import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface.js';
import {
  InboundRateLimitExceededException,
  InboundService,
  type ReceiveInboundWebhookResponse,
} from './inbound.service.js';

@Controller('inbound')
export class InboundGatewayController {
  readonly #inboundService: InboundService;

  constructor(inboundService: InboundService) {
    this.#inboundService = inboundService;
  }

  @Post(':sourceSlug')
  @HttpCode(HttpStatus.OK)
  async receiveWebhook(
    @Param('sourceSlug') sourceSlug: string,
    @Req() request: RawBodyRequest<AuthenticatedRequest>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReceiveInboundWebhookResponse> {
    const contentLength = request.headers['content-length'];
    const isExplicitlyEmpty = contentLength === '0';
    const rawBody =
      request.rawBody !== undefined
        ? request.rawBody
        : isExplicitlyEmpty
          ? Buffer.alloc(0)
          : undefined;

    try {
      return await this.#inboundService.receiveWebhook({
        sourceSlug,
        rawBody,
        headers: request.headers,
        parsedBody: request.body,
      });
    } catch (error: unknown) {
      if (error instanceof InboundRateLimitExceededException) {
        response.setHeader('Retry-After', String(error.retryAfterSec));
      }
      throw error;
    }
  }
}
