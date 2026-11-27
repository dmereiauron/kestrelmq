import { Injectable, UseGuards } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';
import * as z from 'zod';
import { ApiKeyGuard } from '../../../common/guards/api-key.guard.js';
import { maskSensitiveData } from '../../../common/utils/mask-sensitive.util.js';
import { DeliveryStatus } from '../../../generated/prisma/enums.js';
import {
  DEFAULT_DELIVERIES_PAGE_LIMIT,
  DeliveriesService,
  MAX_DELIVERIES_PAGE_LIMIT,
  type PaginatedDeliveriesResponse,
  type ReplayDeliveryResponse,
} from '../../deliveries/deliveries.service.js';
import type { ListDeliveriesQueryDto } from '../../deliveries/dto/list-deliveries-query.dto.js';
import { type KestrelMcpContext, resolveMcpWorkspaceId } from '../mcp-workspace.util.js';

export const listDeliveriesInputSchema = z.strictObject({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_DELIVERIES_PAGE_LIMIT)
    .optional()
    .describe(`Page size (1–${MAX_DELIVERIES_PAGE_LIMIT}, default ${DEFAULT_DELIVERIES_PAGE_LIMIT})`),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('Opaque keyset cursor: the nextCursor of the previous page'),
  status: z.enum(DeliveryStatus).optional().describe('Filter by delivery lifecycle status'),
  eventName: z.string().min(1).max(128).optional().describe('Filter by exact parent event name'),
  integrationId: z.uuid().optional().describe('Filter by target integration id'),
});

export const deliveryIdInputSchema = z.strictObject({
  deliveryId: z.uuid().describe('Delivery id'),
});

export type ListDeliveriesInput = z.infer<typeof listDeliveriesInputSchema>;
export type DeliveryIdInput = z.infer<typeof deliveryIdInputSchema>;

@Injectable()
@UseGuards(ApiKeyGuard)
export class DeliveryTools {
  readonly #deliveriesService: DeliveriesService;

  constructor(deliveriesService: DeliveriesService) {
    this.#deliveriesService = deliveriesService;
  }

  @Tool({
    name: 'list_deliveries',
    title: 'List deliveries',
    description:
      'List the most recent deliveries of the authenticated workspace, newest first, with keyset cursor ' +
      'pagination. Pass the returned nextCursor as cursor to fetch the next page while hasMore is true.',
    inputSchema: listDeliveriesInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  })
  async listDeliveries(
    input: ListDeliveriesInput,
    ctx: KestrelMcpContext,
  ): Promise<PaginatedDeliveriesResponse> {
    const workspaceId = resolveMcpWorkspaceId(ctx);
    const query: ListDeliveriesQueryDto = {
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
      ...(input.integrationId !== undefined ? { integrationId: input.integrationId } : {}),
    };
    return this.#deliveriesService.listDeliveries(workspaceId, query);
  }

  @Tool({
    name: 'inspect_delivery',
    title: 'Inspect delivery',
    description:
      'Get one delivery of the authenticated workspace with its parent event, integration, routing rule and the ' +
      'ordered delivery_attempts audit timeline (HTTP status, response body, error, duration). Sensitive keys ' +
      '(password, apiKey, credentials, token, secret, privateKey) are masked.',
    inputSchema: deliveryIdInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  })
  async inspectDelivery(input: DeliveryIdInput, ctx: KestrelMcpContext): Promise<unknown> {
    const workspaceId = resolveMcpWorkspaceId(ctx);
    const delivery = await this.#deliveriesService.getDeliveryById(workspaceId, input.deliveryId);
    return maskSensitiveData(delivery);
  }

  @Tool({
    name: 'replay_delivery',
    title: 'Replay delivery',
    description:
      'Reset a delivery of the authenticated workspace to PENDING and enqueue it again for the background ' +
      'workers, with a fresh retry budget. Use it for FAILED deliveries after fixing the cause.',
    inputSchema: deliveryIdInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  })
  async replayDelivery(
    input: DeliveryIdInput,
    ctx: KestrelMcpContext,
  ): Promise<ReplayDeliveryResponse> {
    const workspaceId = resolveMcpWorkspaceId(ctx);
    return this.#deliveriesService.replayDelivery(workspaceId, input.deliveryId);
  }
}
