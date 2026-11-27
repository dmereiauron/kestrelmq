import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_SCHEDULE_MS,
  computeBackoffDelayMs,
  kestrelBackoffStrategy,
} from './backoff.util.js';

describe('backoff.util (10s -> 1m -> 5m -> 30m -> 2h)', () => {
  it('computes exact deterministic tiers when jitterRatio is 0 and clamps above tier 5', () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([10_000, 60_000, 300_000, 1_800_000, 7_200_000]);

    expect(computeBackoffDelayMs(1, 0)).toBe(10_000);
    expect(computeBackoffDelayMs(2, 0)).toBe(60_000);
    expect(computeBackoffDelayMs(3, 0)).toBe(300_000);
    expect(computeBackoffDelayMs(4, 0)).toBe(1_800_000);
    expect(computeBackoffDelayMs(5, 0)).toBe(7_200_000);
    expect(computeBackoffDelayMs(8, 0)).toBe(7_200_000);
  });

  it('applies bounded symmetric ±10% jitter and returns -1 on UnrecoverableError', () => {
    expect(computeBackoffDelayMs(1, 0.1, () => 0)).toBe(9_000);
    expect(computeBackoffDelayMs(1, 0.1, () => 0.5)).toBe(10_000);
    expect(computeBackoffDelayMs(1, 0.1, () => 1)).toBe(11_000);

    expect(
      kestrelBackoffStrategy(1, 'kestrel-exponential', new UnrecoverableError('Fatal 400')),
    ).toBe(-1);

    const retryDelay = kestrelBackoffStrategy(2, 'kestrel-exponential', new Error('HTTP 503'));
    expect(retryDelay).toBeGreaterThanOrEqual(54_000);
    expect(retryDelay).toBeLessThanOrEqual(66_000);
  });
});
