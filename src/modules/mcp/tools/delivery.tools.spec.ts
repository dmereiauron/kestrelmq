import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveriesService } from '../../deliveries/deliveries.service.js';
import { createWorkspaceMcpContext } from '../testing/mcp-context.fixture.js';
import { DeliveryTools, deliveryIdInputSchema, listDeliveriesInputSchema } from './delivery.tools.js';

const DELIVERY_ID = '6f1f9f4e-2c55-4d43-9d43-0b8f0c6f6d11';

describe('DeliveryTools', () => {
  let listDeliveries: ReturnType<typeof vi.fn>;
  let getDeliveryById: ReturnType<typeof vi.fn>;
  let replayDelivery: ReturnType<typeof vi.fn>;
  let tools: DeliveryTools;

  beforeEach(() => {
    listDeliveries = vi.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false });
    getDeliveryById = vi.fn();
    replayDelivery = vi.fn().mockResolvedValue({ id: DELIVERY_ID, replayed: true });
    tools = new DeliveryTools({
      listDeliveries,
      getDeliveryById,
      replayDelivery,
    } as unknown as DeliveriesService);
  });

  describe('list_deliveries', () => {
    it('passes filters and cursor for the resolved workspace, never a workspaceId fallback', async () => {
      await tools.listDeliveries(
        {
          limit: 50,
          cursor: 'abc',
          status: 'FAILED',
          eventName: 'order.paid',
          integrationId: DELIVERY_ID,
        },
        createWorkspaceMcpContext('ws-a'),
      );

      expect(listDeliveries).toHaveBeenCalledWith('ws-a', {
        limit: 50,
        cursor: 'abc',
        status: 'FAILED',
        eventName: 'order.paid',
        integrationId: DELIVERY_ID,
      });
      const query = listDeliveries.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(query).not.toHaveProperty('workspaceId');
    });

    it('sends an empty query when no filters are given', async () => {
      await tools.listDeliveries({}, createWorkspaceMcpContext('ws-a'));
      expect(listDeliveries).toHaveBeenCalledWith('ws-a', {});
    });

    it('validates limit bounds, status values and rejects workspaceId', () => {
      expect(listDeliveriesInputSchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(listDeliveriesInputSchema.safeParse({ limit: 101 }).success).toBe(false);
      expect(listDeliveriesInputSchema.safeParse({ status: 'LOST' }).success).toBe(false);
      expect(listDeliveriesInputSchema.safeParse({ workspaceId: 'ws-x' }).success).toBe(false);
      expect(listDeliveriesInputSchema.safeParse({ limit: 20, status: 'PAUSED' }).success).toBe(true);
    });
  });

  describe('inspect_delivery', () => {
    it('returns the delivery with sensitive keys masked again', async () => {
      getDeliveryById.mockResolvedValue({
        id: DELIVERY_ID,
        attempts: [{ attemptNumber: 1, requestPayload: { headers: { authorization: 'Bearer x' } } }],
        event: { payload: { apiKey: 'leaky', orderId: 'ord_1' } },
      });

      const result = await tools.inspectDelivery(
        { deliveryId: DELIVERY_ID },
        createWorkspaceMcpContext('ws-a'),
      );

      expect(getDeliveryById).toHaveBeenCalledWith('ws-a', DELIVERY_ID);
      expect(result).toEqual({
        id: DELIVERY_ID,
        attempts: [{ attemptNumber: 1, requestPayload: { headers: { authorization: '[REDACTED]' } } }],
        event: { payload: { apiKey: '[REDACTED]', orderId: 'ord_1' } },
      });
    });

    it('propagates NotFoundException for deliveries of another workspace', async () => {
      getDeliveryById.mockRejectedValue(new NotFoundException('Delivery not found'));
      await expect(
        tools.inspectDelivery({ deliveryId: DELIVERY_ID }, createWorkspaceMcpContext('ws-b')),
      ).rejects.toThrow(NotFoundException);
    });

    it('requires a UUID deliveryId', () => {
      expect(deliveryIdInputSchema.safeParse({ deliveryId: 'not-a-uuid' }).success).toBe(false);
    });
  });

  describe('replay_delivery', () => {
    it('re-enqueues the delivery through DeliveriesService for the resolved workspace', async () => {
      await expect(
        tools.replayDelivery({ deliveryId: DELIVERY_ID }, createWorkspaceMcpContext('ws-a')),
      ).resolves.toEqual({ id: DELIVERY_ID, replayed: true });
      expect(replayDelivery).toHaveBeenCalledWith('ws-a', DELIVERY_ID);
    });
  });
});
