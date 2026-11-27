import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConnectionOptions } from 'bullmq';
import type { EnvConfig } from '../../config/env.validation.js';
import {
  DEFAULT_DELIVERY_MAX_ATTEMPTS,
  DELIVERIES_DLQ_QUEUE,
  DELIVERIES_QUEUE,
  KESTREL_BACKOFF_TYPE,
} from './queue.constants.js';

export function buildBullConnectionOptions(redisUrl: string): ConnectionOptions {
  const parsed = new URL(redisUrl);
  const port = parsed.port.length > 0 ? Number(parsed.port) : 6379;
  const dbSegment = parsed.pathname.replace(/^\//, '');
  const db =
    dbSegment.length > 0 && /^\d+$/.test(dbSegment) ? Number.parseInt(dbSegment, 10) : undefined;

  const username = parsed.username.length > 0 ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password.length > 0 ? decodeURIComponent(parsed.password) : undefined;

  return {
    host: parsed.hostname || '127.0.0.1',
    port,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig, true>) => ({
        connection: buildBullConnectionOptions(configService.get('REDIS_URL', { infer: true })),
      }),
    }),
    BullModule.registerQueue(
      {
        name: DELIVERIES_QUEUE,
        defaultJobOptions: {
          attempts: DEFAULT_DELIVERY_MAX_ATTEMPTS,
          backoff: {
            type: KESTREL_BACKOFF_TYPE,
          },
          removeOnComplete: {
            count: 1000,
            age: 86_400,
          },
          removeOnFail: false,
        },
      },
      {
        name: DELIVERIES_DLQ_QUEUE,
        defaultJobOptions: {
          removeOnComplete: false,
          removeOnFail: false,
        },
      },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
