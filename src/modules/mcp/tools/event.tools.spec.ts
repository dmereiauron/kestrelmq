import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestionService } from '../../events/ingestion.service.js';
import { createMcpCallFixture, createWorkspaceMcpContext } from '../testing/mcp-context.fixture.js';
import { EventTools, sendEventInputSchema } from './event.tools.js';

describe('EventTools.send_event', () => {
  let ingestEvent: ReturnType<typeof vi.fn>;
  let tools: EventTools;

  beforeEach(() => {
    ingestEvent = vi.fn().mockResolvedValue({ eventId: 'evt-1', deliveryIds: ['del-1'] });
    tools = new EventTools({ ingestEvent } as unknown as IngestionService);
  });

  it('ingests the event for the resolved workspace with all optional fields mapped', async () => {
    const result = await tools.sendEvent(
      {
        event: 'order.paid',
        payload: { orderId: 'ord_1' },
        recipient: { email: 'ada@example.com' },
        idempotencyKey: 'idem-1',
        deliverAt: '2026-12-01T12:00:00.000Z',
      },
      createWorkspaceMcpContext('ws-a', 'send_event'),
    );

    expect(result).toEqual({ eventId: 'evt-1', deliveryIds: ['del-1'] });
    expect(ingestEvent).toHaveBeenCalledWith('ws-a', {
      event: 'order.paid',
      payload: { orderId: 'ord_1' },
      recipient: { email: 'ada@example.com' },
      idempotencyKey: 'idem-1',
      deliverAt: '2026-12-01T12:00:00.000Z',
    });
  });

  it('omits optional fields that were not provided', async () => {
    await tools.sendEvent({ event: 'user.signup', payload: {} }, createWorkspaceMcpContext('ws-b'));
    expect(ingestEvent).toHaveBeenCalledWith('ws-b', { event: 'user.signup', payload: {} });
  });

  it('refuses to run without a verified workspace', async () => {
    await expect(
      tools.sendEvent({ event: 'order.paid', payload: {} }, createMcpCallFixture().mcpContext),
    ).rejects.toThrow(UnauthorizedException);
    expect(ingestEvent).not.toHaveBeenCalled();
  });

  describe('input schema', () => {
    it('rejects a client-supplied workspaceId (strict object)', () => {
      const parsed = sendEventInputSchema.safeParse({
        event: 'order.paid',
        payload: {},
        workspaceId: 'ws-other',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects event names with whitespace and non-ISO deliverAt', () => {
      expect(sendEventInputSchema.safeParse({ event: 'order paid', payload: {} }).success).toBe(false);
      expect(
        sendEventInputSchema.safeParse({ event: 'a', payload: {}, deliverAt: 'tomorrow' }).success,
      ).toBe(false);
    });
  });
});
