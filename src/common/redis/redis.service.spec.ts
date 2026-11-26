import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import { RedisService } from './redis.service.js';

describe('RedisService', () => {
  let service: RedisService;

  beforeEach(() => {
    const mockConfigService = {
      get: vi.fn().mockReturnValue('redis://localhost:6379'),
    } as unknown as ConfigService<EnvConfig, true>;

    service = new RedisService(mockConfigService);
  });

  it('delegates get, setEx, del, eval, and ping to underlying ioredis client', async () => {
    const client = service.getClient();
    const getSpy = vi.spyOn(client, 'get').mockResolvedValue('cached-val');
    const setSpy = vi.spyOn(client, 'set').mockResolvedValue('OK');
    const delSpy = vi.spyOn(client, 'del').mockResolvedValue(2);
    const evalSpy = vi.spyOn(client, 'eval').mockResolvedValue('ROTATED');
    const pingSpy = vi.spyOn(client, 'ping').mockResolvedValue('PONG');

    expect(await service.get('k1')).toBe('cached-val');
    expect(getSpy).toHaveBeenCalledWith('k1');

    await service.setEx('k1', 300, 'v1');
    expect(setSpy).toHaveBeenCalledWith('k1', 'v1', 'EX', 300);

    expect(await service.del()).toBe(0);
    expect(delSpy).not.toHaveBeenCalled();

    expect(await service.del('k1', 'k2')).toBe(2);
    expect(delSpy).toHaveBeenCalledWith('k1', 'k2');

    expect(await service.eval('return 1', ['k1'], ['a1', 60])).toBe('ROTATED');
    expect(evalSpy).toHaveBeenCalledWith('return 1', 1, 'k1', 'a1', 60);

    expect(await service.ping()).toBe('PONG');
    expect(pingSpy).toHaveBeenCalledOnce();

    client.disconnect();
  });

  it('connects on onModuleInit when client is in wait state and skips otherwise', async () => {
    const client = service.getClient();
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);

    Object.defineProperty(client, 'status', { value: 'wait', configurable: true });
    await service.onModuleInit();
    expect(connectSpy).toHaveBeenCalledOnce();

    Object.defineProperty(client, 'status', { value: 'ready', configurable: true });
    await service.onModuleInit();
    expect(connectSpy).toHaveBeenCalledOnce();
  });

  it('cleanly shuts down across wait, ready, end, and failed quit states', async () => {
    const client = service.getClient();
    const quitSpy = vi.spyOn(client, 'quit').mockResolvedValue('OK');
    const disconnectSpy = vi.spyOn(client, 'disconnect').mockReturnValue(undefined);

    Object.defineProperty(client, 'status', { value: 'end', configurable: true });
    await service.onModuleDestroy();
    expect(quitSpy).not.toHaveBeenCalled();
    expect(disconnectSpy).not.toHaveBeenCalled();

    Object.defineProperty(client, 'status', { value: 'wait', configurable: true });
    await service.onModuleDestroy();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(client, 'status', { value: 'ready', configurable: true });
    await service.onModuleDestroy();
    expect(quitSpy).toHaveBeenCalledTimes(1);

    quitSpy.mockRejectedValueOnce(new Error('Connection closed'));
    await service.onModuleDestroy();
    expect(disconnectSpy).toHaveBeenCalledTimes(2);
  });
});
