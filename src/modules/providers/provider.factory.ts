import { Inject, Injectable } from '@nestjs/common';
import type { IntegrationProvider } from '../../generated/prisma/enums.js';
import { ProviderConfigurationError } from './errors/provider-delivery.error.js';
import {
  NOTIFICATION_PROVIDERS,
  NotificationProvider,
} from './interfaces/notification-provider.interface.js';

@Injectable()
export class ProviderFactory {
  readonly #providers: ReadonlyMap<IntegrationProvider, NotificationProvider>;

  constructor(@Inject(NOTIFICATION_PROVIDERS) providers: readonly NotificationProvider[]) {
    const registry = new Map<IntegrationProvider, NotificationProvider>();
    for (const adapter of providers) {
      if (registry.has(adapter.provider)) {
        throw new Error(
          `Duplicate NotificationProvider registered for "${adapter.provider}"`,
        );
      }
      registry.set(adapter.provider, adapter);
    }
    this.#providers = registry;
  }

  getProvider(provider: IntegrationProvider): NotificationProvider {
    const adapter = this.#providers.get(provider);
    if (!adapter) {
      throw new ProviderConfigurationError(
        provider,
        `Notification provider "${provider}" is not supported`,
      );
    }
    return adapter;
  }

  hasProvider(provider: IntegrationProvider): boolean {
    return this.#providers.has(provider);
  }

  getSupportedProviders(): IntegrationProvider[] {
    return [...this.#providers.keys()];
  }
}
