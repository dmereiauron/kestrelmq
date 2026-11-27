import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { CryptoModule } from '../../common/crypto/crypto.module.js';
import { PrismaModule } from '../../common/prisma/prisma.module.js';
import { QueueModule } from '../../common/queue/queue.module.js';
import { RedisModule } from '../../common/redis/redis.module.js';
import { validateEnv } from '../../config/env.validation.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { RulesModule } from '../rules/rules.module.js';
import { TemplatesModule } from '../templates/templates.module.js';
import { DeliveryProcessor } from './delivery.processor.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    JwtModule.register({
      global: true,
    }),
    PrismaModule,
    RedisModule,
    QueueModule,
    CryptoModule,
    ProvidersModule,
    IntegrationsModule,
    TemplatesModule,
    RulesModule,
  ],
  providers: [DeliveryProcessor],
  exports: [DeliveryProcessor],
})
export class WorkerModule {}
