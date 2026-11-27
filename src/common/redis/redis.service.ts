import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { EnvConfig } from '../../config/env.validation.js';

export interface SlidingWindowRateLimitResult {
  readonly allowed: boolean;
  readonly currentCount: number;
  readonly retryAfterMs: number;
}

const COMPARE_AND_DEL_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const SLIDING_WINDOW_RATE_LIMIT_LUA = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local member = ARGV[4]
local minScore = nowMs - windowMs

redis.call("ZREMRANGEBYSCORE", key, "-inf", minScore)
local currentCount = redis.call("ZCARD", key)

if currentCount >= maxRequests then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retryAfterMs = windowMs
  if oldest ~= nil and #oldest >= 2 then
    local oldestScore = tonumber(oldest[2])
    if oldestScore ~= nil then
      retryAfterMs = math.max(1, windowMs - (nowMs - oldestScore))
    end
  end
  return { 0, currentCount, retryAfterMs }
end

redis.call("ZADD", key, nowMs, member)
redis.call("PEXPIRE", key, windowMs + 1000)
return { 1, currentCount + 1, 0 }
`;

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

  async setNxEx(key: string, ttlSeconds: number, value: string): Promise<boolean> {
    const result = await this.#client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async compareAndDel(key: string, expectedValue: string): Promise<boolean> {
    const deleted = await this.eval(COMPARE_AND_DEL_LUA, [key], [expectedValue]);
    return Number(deleted) === 1;
  }

  async checkSlidingWindowRateLimit(
    key: string,
    maxRequests: number,
    windowMs = 1_000,
    nowMs: number = Date.now(),
    memberId: string = `${nowMs}:${randomUUID()}`,
  ): Promise<SlidingWindowRateLimitResult> {
    const rawResult = await this.eval(
      SLIDING_WINDOW_RATE_LIMIT_LUA,
      [key],
      [nowMs, windowMs, maxRequests, memberId],
    );

    if (Array.isArray(rawResult) && rawResult.length >= 3) {
      const allowedFlag = Number(rawResult[0]);
      const currentCount = Number(rawResult[1]);
      const retryAfterMs = Number(rawResult[2]);
      return {
        allowed: allowedFlag === 1,
        currentCount: Number.isFinite(currentCount) ? currentCount : 0,
        retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, Math.ceil(retryAfterMs)) : windowMs,
      };
    }

    throw new Error('Unexpected response from Redis sliding-window rate limiter script');
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
