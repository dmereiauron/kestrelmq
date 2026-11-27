export const DELIVERIES_QUEUE = 'deliveries' as const;
export const DELIVERIES_DLQ_QUEUE = 'deliveries-dlq' as const;
export const MAINTENANCE_QUEUE = 'maintenance' as const;
export const KESTREL_BACKOFF_TYPE = 'kestrel-exponential' as const;

export const DEFAULT_DELIVERY_MAX_ATTEMPTS = 5 as const;

export const DELIVERY_JOB_NAMES = {
  DELIVER_OUTBOUND: 'deliver-outbound',
  DELIVER_INBOUND: 'deliver-inbound',
} as const;

export const DLQ_JOB_NAMES = {
  DEAD_LETTER_DELIVERY: 'dead-letter-delivery',
} as const;

export const MAINTENANCE_JOB_NAMES = {
  CLEANUP_DELIVERY_ATTEMPTS: 'cleanup-delivery-attempts',
} as const;

export interface CleanupDeliveryAttemptsJobPayload {
  readonly nowMs?: number;
  readonly batchSize?: number;
  readonly maxBatchesPerPlan?: number;
}

export interface DeliveryJobPayload {
  readonly deliveryId: string;
  readonly workspaceId: string;
  readonly eventId: string;
}

export interface DlqJobPayload {
  readonly deliveryId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly errorMessage: string;
  readonly statusCode: number | null;
  readonly attemptsMade: number;
  readonly failedAt: string;
}
