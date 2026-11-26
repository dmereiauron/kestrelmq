import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import { PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  it('connects on module init and disconnects client + pool on module destroy', async () => {
    const dbPass = randomBytes(12).toString('hex');
    const mockConfigService = {
      get: vi.fn().mockReturnValue(`postgresql://kestrelmq:${dbPass}@localhost:5432/kestrelmq`),
    } as unknown as ConfigService<EnvConfig, true>;

    const service = new PrismaService(mockConfigService);
    const connectSpy = vi.spyOn(service, '$connect').mockResolvedValue(undefined);
    const disconnectSpy = vi.spyOn(service, '$disconnect').mockResolvedValue(undefined);

    await service.onModuleInit();
    expect(connectSpy).toHaveBeenCalledOnce();

    await service.onModuleDestroy();
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });
});
