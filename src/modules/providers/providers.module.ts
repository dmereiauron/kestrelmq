import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { MailgunAdapter } from './adapters/mailgun.adapter.js';
import { TelegramAdapter } from './adapters/telegram.adapter.js';
import { WebhookAdapter } from './adapters/webhook.adapter.js';
import {
  NOTIFICATION_PROVIDERS,
  NotificationProvider,
} from './interfaces/notification-provider.interface.js';
import { ProviderFactory } from './provider.factory.js';

const BUILTIN_ADAPTERS: ReadonlyArray<Type<NotificationProvider>> = [
  WebhookAdapter,
  TelegramAdapter,
  MailgunAdapter,
];

function createProvidersArrayProvider(
  adapterClasses: ReadonlyArray<Type<NotificationProvider>>,
): Provider<readonly NotificationProvider[]> {
  return {
    provide: NOTIFICATION_PROVIDERS,
    useFactory: (...adapters: NotificationProvider[]): readonly NotificationProvider[] => adapters,
    inject: [...adapterClasses],
  };
}

@Module({
  providers: [
    ...BUILTIN_ADAPTERS,
    createProvidersArrayProvider(BUILTIN_ADAPTERS),
    ProviderFactory,
  ],
  exports: [ProviderFactory, NOTIFICATION_PROVIDERS, ...BUILTIN_ADAPTERS],
})
export class ProvidersModule {
  static register(extraAdapters: ReadonlyArray<Type<NotificationProvider>> = []): DynamicModule {
    const allAdapters = [...BUILTIN_ADAPTERS, ...extraAdapters];
    return {
      module: ProvidersModule,
      providers: [...allAdapters, createProvidersArrayProvider(allAdapters), ProviderFactory],
      exports: [ProviderFactory, NOTIFICATION_PROVIDERS, ...allAdapters],
    };
  }
}
