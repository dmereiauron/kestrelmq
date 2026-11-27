import type { IntegrationChannel, IntegrationProvider } from '../../../generated/prisma/enums.js';
import type { ProviderCredentials } from '../schemas/provider-credentials.schema.js';

export const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000 as const;

export const NOTIFICATION_PROVIDERS = Symbol('NOTIFICATION_PROVIDERS');

export interface ProviderContent {
  readonly subject?: string;
  readonly body: string;
  readonly html?: string;
  readonly text?: string;
}

export interface ProviderSendMetadata {
  readonly eventId?: string;
  readonly eventName?: string;
  readonly deliveryId?: string;
  readonly workspaceSigningSecret?: string;
  readonly timestampSec?: number;
}

export interface ProviderSendRequest {
  readonly credentials: ProviderCredentials;
  readonly target?: string;
  readonly content: ProviderContent;
  readonly metadata?: ProviderSendMetadata;
}

export interface ProviderTestContext {
  readonly target?: string;
  readonly workspaceSigningSecret?: string;
}

export interface ProviderSendResult {
  readonly provider: IntegrationProvider;
  readonly statusCode: number;
  readonly responseBody: string;
  readonly durationMs: number;
}

export abstract class NotificationProvider {
  abstract readonly provider: IntegrationProvider;
  abstract readonly channel: IntegrationChannel;

  abstract send(request: ProviderSendRequest): Promise<ProviderSendResult>;

  abstract testConnection(
    credentials: ProviderCredentials,
    context: ProviderTestContext,
  ): Promise<ProviderSendResult>;
}
