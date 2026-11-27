import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { CryptoModule } from './common/crypto/crypto.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { QueueModule } from './common/queue/queue.module.js';
import { RedisModule } from './common/redis/redis.module.js';
import { validateEnv } from './config/env.validation.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DeliveriesModule } from './modules/deliveries/deliveries.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { InboundModule } from './modules/inbound/inbound.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';
import { ProvidersModule } from './modules/providers/providers.module.js';
import { RulesModule } from './modules/rules/rules.module.js';
import { EventSchemasModule } from './modules/schemas/event-schemas.module.js';
import { TemplatesModule } from './modules/templates/templates.module.js';
import { WorkspacesModule } from './modules/workspaces/workspaces.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: process.env['NODE_ENV'] === 'test',
      validate: validateEnv,
    }),
    PrismaModule,
    RedisModule,
    QueueModule,
    CryptoModule,
    AuthModule,
    WorkspacesModule,
    ProvidersModule,
    IntegrationsModule,
    TemplatesModule,
    RulesModule,
    EventSchemasModule,
    EventsModule,
    DeliveriesModule,
    AnalyticsModule,
    InboundModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: {
          enableImplicitConversion: false,
        },
      }),
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
