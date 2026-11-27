import { UnrecoverableError } from 'bullmq';

/**
 * Exponential backoff schedule per SPEC.md §3.3:
 * 10s -> 1m -> 5m -> 30m -> 2h
 */
export const BACKOFF_SCHEDULE_MS = [
  10_000,
  60_000,
  300_000,
  1_800_000,
  7_200_000,
] as const;

export const DEFAULT_BACKOFF_JITTER_RATIO = 0.1 as const;

function resolveBackoffScaleFactor(): number {
  const raw = process.env['BACKOFF_SCALE_FACTOR'];
  if (raw === undefined || raw.trim().length === 0) {
    return 1;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Computes the retry delay in milliseconds for `attemptsMade` (1-based count of failed attempts)
 * along the `10s -> 1m -> 5m -> 30m -> 2h` curve with bounded symmetric jitter (`±jitterRatio`).
 */
export function computeBackoffDelayMs(
  attemptsMade: number,
  jitterRatio: number = DEFAULT_BACKOFF_JITTER_RATIO,
  randomFn: () => number = Math.random,
): number {
  const normalizedAttempt = Number.isFinite(attemptsMade) ? Math.trunc(attemptsMade) : 1;
  const tierIndex = Math.min(
    Math.max(normalizedAttempt - 1, 0),
    BACKOFF_SCHEDULE_MS.length - 1,
  );
  const scaleFactor = resolveBackoffScaleFactor();
  const baseDelayMs = Math.max(1, Math.round(BACKOFF_SCHEDULE_MS[tierIndex]! * scaleFactor));

  if (jitterRatio <= 0) {
    return baseDelayMs;
  }

  const clampedRatio = Math.min(jitterRatio, 0.5);
  const jitterFactor = (randomFn() * 2 - 1) * clampedRatio;
  return Math.max(1, Math.round(baseDelayMs * (1 + jitterFactor)));
}

/**
 * BullMQ v6 custom `settings.backoffStrategy` callback.
 * Returns `-1` for `UnrecoverableError` to immediately move fatal jobs to `failed`.
 */
export function kestrelBackoffStrategy(
  attemptsMade: number,
  _type?: string,
  err?: Error,
): number {
  if (err instanceof UnrecoverableError) {
    return -1;
  }

  return computeBackoffDelayMs(attemptsMade);
}
