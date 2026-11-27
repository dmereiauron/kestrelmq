import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvConfig } from '../../config/env.validation.js';
import { buildBullConnectionOptions } from '../queue/queue.module.js';
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

  it('supports atomic setNxEx, compareAndDel, and sliding-window ZSET rate limiting', async () => {
    const client = service.getClient();
    const setSpy = vi.spyOn(client, 'set');
    const evalSpy = vi.spyOn(client, 'eval');

    setSpy.mockResolvedValueOnce('OK');
    expect(await service.setNxEx('idem:1', 86_400, 'PROCESSING:abc')).toBe(true);
    expect(setSpy).toHaveBeenCalledWith('idem:1', 'PROCESSING:abc', 'EX', 86_400, 'NX');

    setSpy.mockImplementationOnce((async () => null) as unknown as typeof client.set);
    expect(await service.setNxEx('idem:1', 86_400, 'PROCESSING:def')).toBe(false);

    evalSpy.mockResolvedValueOnce(1);
    expect(await service.compareAndDel('idem:1', 'PROCESSING:abc')).toBe(true);

    evalSpy.mockResolvedValueOnce(0);
    expect(await service.compareAndDel('idem:1', 'PROCESSING:wrong')).toBe(false);

    evalSpy.mockResolvedValueOnce([1, 3, 0]);
    const allowed = await service.checkSlidingWindowRateLimit('rl:src:1', 10, 1_000, 1_700_000_000_000, 'm1');
    expect(allowed).toEqual({
      allowed: true,
      currentCount: 3,
      retryAfterMs: 0,
    });

    evalSpy.mockResolvedValueOnce([0, 10, 420]);
    const throttled = await service.checkSlidingWindowRateLimit('rl:src:1', 10, 1_000, 1_700_000_000_580, 'm2');
    expect(throttled).toEqual({
      allowed: false,
      currentCount: 10,
      retryAfterMs: 420,
    });

    evalSpy.mockResolvedValueOnce('unexpected');
    await expect(service.checkSlidingWindowRateLimit('rl:src:1', 10)).rejects.toThrow(
      'Unexpected response from Redis sliding-window rate limiter script',
    );

    client.disconnect();
  });

  it('parses redis:// and rediss:// connection URLs for BullMQ workers', () => {
    const plain = buildBullConnectionOptions('redis://localhost:6380/2');
    expect(plain).toEqual({
      host: 'localhost',
      port: 6380,
      db: 2,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    const dynamicAuth = randomBytes(8).toString('hex');
    const tlsOpts = buildBullConnectionOptions(`rediss://default:${dynamicAuth}@cache.internal:6379`);
    expect(tlsOpts).toEqual({
      host: 'cache.internal',
      port: 6379,
      username: 'default',
      password: dynamicAuth,
      tls: {},
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });
});
