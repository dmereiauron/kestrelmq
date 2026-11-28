import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import type { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface.js';
import { ProblemDetailsDto } from '../../common/swagger/problem-details.dto.js';
import {
  InboundService,
  type ReceiveInboundWebhookResponse,
} from './inbound.service.js';

@ApiTags('Inbound Gateway')
@Public()
@Controller('inbound')
export class InboundGatewayController {
  readonly #inboundService: InboundService;

  constructor(inboundService: InboundService) {
    this.#inboundService = inboundService;
  }

  @Post(':sourceSlug')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Public inbound webhook receiver with constant-time rawBody HMAC verification',
  })
  @ApiHeader({
    name: 'Stripe-Signature',
    required: false,
    description: 'Stripe HMAC header (t=<unix_sec>,v1=<hex>) when providerType is STRIPE',
  })
  @ApiHeader({
    name: 'X-Shopify-Hmac-Sha256',
    required: false,
    description: 'Shopify Base64 HMAC-SHA256 header when providerType is SHOPIFY',
  })
  @ApiHeader({
    name: 'X-Hub-Signature-256',
    required: false,
    description: 'GitHub sha256=<hex> header when providerType is GITHUB',
  })
  @ApiHeader({
    name: 'X-KestrelMQ-Signature',
    required: false,
    description: 'Custom HMAC v1=<hex> header (paired with X-KestrelMQ-Timestamp)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: true,
    },
  })
  @ApiOkResponse({ description: 'Webhook verified and persisted/enqueued (or buffered if paused)' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid upstream webhook HMAC signature',
    type: ProblemDetailsDto,
  })
  @ApiResponse({ status: 404, description: 'Inbound source slug not found', type: ProblemDetailsDto })
  async receiveWebhook(
    @Param('sourceSlug') sourceSlug: string,
    @Req() request: RawBodyRequest<AuthenticatedRequest>,
  ): Promise<ReceiveInboundWebhookResponse> {
    const contentLength = request.headers['content-length'];
    const isExplicitlyEmpty = contentLength === '0';
    const rawBody =
      request.rawBody !== undefined
        ? request.rawBody
        : isExplicitlyEmpty
          ? Buffer.alloc(0)
          : undefined;

    return this.#inboundService.receiveWebhook({
      sourceSlug,
      rawBody,
      headers: request.headers,
      parsedBody: request.body,
    });
  }
}
