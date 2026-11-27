import type { IntegrationProvider } from '../../../generated/prisma/enums.js';

export function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

export function redactSecretsFromText(text: string, secrets: readonly string[]): string {
  let sanitized = text.replace(/\/bot[^/\s?]+/gi, '/bot[REDACTED]');
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length > 0) {
      sanitized = sanitized.split(trimmed).join('[REDACTED]');
    }
  }
  return sanitized;
}

export class ProviderConfigurationError extends Error {
  readonly provider: IntegrationProvider;

  constructor(provider: IntegrationProvider, message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
    this.provider = provider;
  }
}

export interface ProviderDeliveryErrorOptions {
  readonly provider: IntegrationProvider;
  readonly message: string;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly responseBody: string | null;
  readonly durationMs: number;
  readonly cause?: unknown;
}

export class ProviderDeliveryError extends Error {
  readonly provider: IntegrationProvider;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly responseBody: string | null;
  readonly durationMs: number;

  constructor(options: ProviderDeliveryErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProviderDeliveryError';
    this.provider = options.provider;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.responseBody = options.responseBody;
    this.durationMs = options.durationMs;
  }
}
