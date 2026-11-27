import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundService } from '../../inbound/inbound.service.js';
import { createWorkspaceMcpContext } from '../testing/mcp-context.fixture.js';
import { InboundTools, toggleInboundSourceInputSchema } from './inbound.tools.js';

const SOURCE_ID = '0b7a3f8e-9c1d-4e2f-8a6b-5c4d3e2f1a0b';

describe('InboundTools.toggle_inbound_source', () => {
  let pauseSource: ReturnType<typeof vi.fn>;
  let resumeSource: ReturnType<typeof vi.fn>;
  let tools: InboundTools;

  beforeEach(() => {
    pauseSource = vi.fn().mockResolvedValue({ id: SOURCE_ID, isPaused: true });
    resumeSource = vi
      .fn()
      .mockResolvedValue({ source: { id: SOURCE_ID, isPaused: false }, resumedDeliveriesCount: 12 });
    tools = new InboundTools({ pauseSource, resumeSource } as unknown as InboundService);
  });

  it('pauses the source for the resolved workspace', async () => {
    await expect(
      tools.toggleInboundSource(
        { sourceId: SOURCE_ID, action: 'pause' },
        createWorkspaceMcpContext('ws-a'),
      ),
    ).resolves.toEqual({ action: 'pause', source: { id: SOURCE_ID, isPaused: true } });
    expect(pauseSource).toHaveBeenCalledWith('ws-a', SOURCE_ID);
    expect(resumeSource).not.toHaveBeenCalled();
  });

  it('resumes the source and reports how many buffered deliveries drain', async () => {
    await expect(
      tools.toggleInboundSource(
        { sourceId: SOURCE_ID, action: 'resume' },
        createWorkspaceMcpContext('ws-a'),
      ),
    ).resolves.toEqual({
      action: 'resume',
      source: { id: SOURCE_ID, isPaused: false },
      resumedDeliveriesCount: 12,
    });
    expect(resumeSource).toHaveBeenCalledWith('ws-a', SOURCE_ID);
  });

  it('propagates NotFoundException for sources of another workspace', async () => {
    pauseSource.mockRejectedValue(new NotFoundException('Inbound source not found'));
    await expect(
      tools.toggleInboundSource(
        { sourceId: SOURCE_ID, action: 'pause' },
        createWorkspaceMcpContext('ws-b'),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('only accepts pause or resume', () => {
    expect(
      toggleInboundSourceInputSchema.safeParse({ sourceId: SOURCE_ID, action: 'delete' }).success,
    ).toBe(false);
  });
});
