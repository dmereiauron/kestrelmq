export type DeliveryStatus =
  | 'PENDING'
  | 'SCHEDULED'
  | 'RETRYING'
  | 'DELIVERED'
  | 'FAILED'
  | 'CANCELED'
  | 'PAUSED';

export type EventDirection = 'OUTBOUND' | 'INBOUND';

export type IntegrationChannel = 'EMAIL' | 'TELEGRAM' | 'WEBHOOK' | 'SLACK';

export type IntegrationProvider =
  | 'MAILGUN'
  | 'RESEND'
  | 'SMTP'
  | 'TELEGRAM_BOT'
  | 'CUSTOM_WEBHOOK';

export type AnalyticsWindow = '24h' | '7d' | '30d';

export interface KestrelClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly workspaceId?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface SendEventInput {
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly recipient?: Record<string, unknown>;
  readonly deliverAt?: string | Date;
  readonly idempotencyKey?: string;
}

export interface IngestedDeliverySummary {
  readonly id: string;
  readonly routingRuleId: string | null;
  readonly integrationId: string | null;
  readonly status: DeliveryStatus;
  readonly scheduledFor: string | null;
}

export interface SendEventResponse {
  readonly eventId: string;
  readonly eventName: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string | null;
  readonly idempotentReplay: boolean;
  readonly scheduledFor: string | null;
  readonly schemaWarnings: unknown;
  readonly deliveryIds: readonly string[];
  readonly deliveries: readonly IngestedDeliverySummary[];
  readonly createdAt: string;
}

export type CsvUploadInput =
  | Blob
  | Buffer
  | Uint8Array
  | string
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>;

export interface SendBulkOptions {
  readonly filename?: string;
  readonly timeoutMs?: number;
}

export interface BulkRowValidationError {
  readonly row: number;
  readonly message: string;
}

export interface BulkIngestResponse {
  readonly totalRows: number;
  readonly importedEvents: number;
  readonly createdDeliveries: number;
  readonly skippedDuplicates: number;
  readonly failedRows: number;
  readonly errors: readonly BulkRowValidationError[];
}

export interface ListDeliveriesParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: DeliveryStatus;
  readonly eventName?: string;
  readonly integrationId?: string;
}

export interface DeliveryListItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly routingRuleId: string | null;
  readonly integrationId: string | null;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly event: {
    readonly id: string;
    readonly eventName: string;
    readonly direction: EventDirection;
    readonly scheduledFor: string | null;
    readonly createdAt: string;
  };
  readonly integration: {
    readonly id: string;
    readonly name: string;
    readonly channel: IntegrationChannel;
    readonly provider: IntegrationProvider;
  } | null;
}

export interface PaginatedDeliveriesResponse {
  readonly data: readonly DeliveryListItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface DeliveryAttemptAuditItem {
  readonly id: string;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly requestPayload: unknown;
  readonly responseStatus: number | null;
  readonly responseBody: string | null;
  readonly errorMessage: string | null;
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface DeliveryDetailResponse extends Omit<DeliveryListItem, 'event' | 'integration'> {
  readonly event: {
    readonly id: string;
    readonly eventName: string;
    readonly direction: EventDirection;
    readonly recipient: unknown;
    readonly payload: unknown;
    readonly scheduledFor: string | null;
    readonly schemaWarnings: unknown;
    readonly inboundSourceId: string | null;
    readonly createdAt: string;
  };
  readonly integration: {
    readonly id: string;
    readonly name: string;
    readonly channel: IntegrationChannel;
    readonly provider: IntegrationProvider;
    readonly isActive: boolean;
  } | null;
  readonly routingRule: {
    readonly id: string;
    readonly eventName: string;
    readonly templateId: string | null;
    readonly targetOverride: string | null;
    readonly isActive: boolean;
  } | null;
  readonly attempts: readonly DeliveryAttemptAuditItem[];
}

export interface ReplayDeliveryResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: string | null;
  readonly replayed: true;
  readonly jobId: string;
}

export interface CancelDeliveryResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly status: DeliveryStatus;
  readonly nextRetryAt: string | null;
  readonly canceled: true;
  readonly removedFromQueue: boolean;
}

export interface DeliveriesByStatusCounts {
  readonly DELIVERED: number;
  readonly FAILED: number;
  readonly RETRYING: number;
  readonly PENDING: number;
  readonly SCHEDULED: number;
  readonly PAUSED: number;
  readonly CANCELED: number;
}

export interface AnalyticsSummaryResponse {
  readonly workspaceId: string;
  readonly window: AnalyticsWindow;
  readonly from: string;
  readonly to: string;
  readonly totalEvents: number;
  readonly totalDeliveries: number;
  readonly deliveriesByStatus: DeliveriesByStatusCounts;
  readonly successRate: number;
  readonly avgDurationMs: number;
  readonly p95DurationMs: number;
  readonly cached: boolean;
}
