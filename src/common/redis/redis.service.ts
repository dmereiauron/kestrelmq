import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { EnvConfig } from '../../config/env.validation.js';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly #client: Redis;

  constructor(configService: ConfigService<EnvConfig, true>) {
    const redisUrl = configService.get('REDIS_URL', { infer: true });
    this.#client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }

  getClient(): Redis {
    return this.#client;
  }

  async get(key: string): Promise<string | null> {
    return this.#client.get(key);
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.#client.set(key, value, 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    return this.#client.del(...keys);
  }

  async eval(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    return this.#client.eval(script, keys.length, ...keys, ...args);
  }

  async ping(): Promise<string> {
    return this.#client.ping();
  }

  async onModuleInit(): Promise<void> {
    if (this.#client.status === 'wait') {
      await this.#client.connect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    const status = this.#client.status;
    if (status === 'end') {
      return;
    }
    if (status === 'wait') {
      this.#client.disconnect();
      return;
    }

    try {
      await this.#client.quit();
    } catch {
      this.#client.disconnect();
    }
  }
}
