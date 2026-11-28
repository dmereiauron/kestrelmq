import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation.js';

function buildValidEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dbPass = randomBytes(12).toString('hex');
  return {
    NODE_ENV: 'test',
    PORT: '4000',
    POSTGRES_URL: `postgresql://kestrelmq:${dbPass}@localhost:5432/kestrelmq`,
    REDIS_URL: 'redis://localhost:6379',
    APP_SECRET: randomBytes(24).toString('hex'),
    ENCRYPTION_MASTER_KEY: randomBytes(32).toString('hex'),
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    ...overrides,
  };
}

describe('validateEnv', () => {
  it('parses valid configuration and coerces PORT and JWT TTLs to numbers', () => {
    const raw = buildValidEnv({
      JWT_ACCESS_TTL_SEC: '600',
      JWT_REFRESH_TTL_SEC: '86400',
    });
    const parsed = validateEnv(raw);

    expect(parsed.NODE_ENV).toBe('test');
    expect(parsed.PORT).toBe(4000);
    expect(parsed.POSTGRES_URL).toBe(raw['POSTGRES_URL']);
    expect(parsed.REDIS_URL).toBe('redis://localhost:6379');
    expect(parsed.JWT_ACCESS_TTL_SEC).toBe(600);
    expect(parsed.JWT_REFRESH_TTL_SEC).toBe(86400);
  });

  it('applies defaults for NODE_ENV, PORT, CORS_ORIGINS, JWT TTLs, and rate limit quotas when omitted', () => {
    const raw = buildValidEnv({ NODE_ENV: undefined, PORT: undefined });
    const parsed = validateEnv(raw);

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.PORT).toBe(3000);
    expect(parsed.CORS_ORIGINS).toBe('http://localhost:3001');
    expect(parsed.JWT_ACCESS_TTL_SEC).toBe(900);
    expect(parsed.JWT_REFRESH_TTL_SEC).toBe(604800);
    expect(parsed.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(parsed.RATE_LIMIT_FREE_MAX).toBe(60);
    expect(parsed.RATE_LIMIT_PRO_MAX).toBe(600);
    expect(parsed.RATE_LIMIT_ENTERPRISE_MAX).toBe(3_000);
  });

  it('accepts comma-separated CORS_ORIGINS and rejects blank values', () => {
    const parsed = validateEnv(
      buildValidEnv({
        CORS_ORIGINS: 'http://localhost:3001, https://dashboard.kestrelmq.io',
      }),
    );
    expect(parsed.CORS_ORIGINS).toBe('http://localhost:3001, https://dashboard.kestrelmq.io');

    expect(() => validateEnv(buildValidEnv({ CORS_ORIGINS: '   ' }))).toThrow(
      /CORS_ORIGINS/,
    );
    expect(() => validateEnv(buildValidEnv({ CORS_ORIGINS: ' , ' }))).toThrow(
      /CORS_ORIGINS/,
    );
  });

  it('coerces custom rate limit environment variables when provided', () => {
    const raw = buildValidEnv({
      RATE_LIMIT_WINDOW_MS: '10000',
      RATE_LIMIT_FREE_MAX: '25',
      RATE_LIMIT_PRO_MAX: '250',
      RATE_LIMIT_ENTERPRISE_MAX: '2500',
    });
    const parsed = validateEnv(raw);

    expect(parsed.RATE_LIMIT_WINDOW_MS).toBe(10_000);
    expect(parsed.RATE_LIMIT_FREE_MAX).toBe(25);
    expect(parsed.RATE_LIMIT_PRO_MAX).toBe(250);
    expect(parsed.RATE_LIMIT_ENTERPRISE_MAX).toBe(2_500);
  });

  it('accepts postgres:// and rediss:// scheme variants', () => {
    const dbPass = randomBytes(12).toString('hex');
    const parsed = validateEnv(
      buildValidEnv({
        POSTGRES_URL: `postgres://kestrelmq:${dbPass}@127.0.0.1:5432/kestrelmq`,
        REDIS_URL: 'rediss://localhost:6380',
      }),
    );

    expect(parsed.POSTGRES_URL.startsWith('postgres://')).toBe(true);
    expect(parsed.REDIS_URL).toBe('rediss://localhost:6380');
  });

  it('throws formatted error when POSTGRES_URL or REDIS_URL has invalid protocol', () => {
    expect(() =>
      validateEnv(buildValidEnv({ POSTGRES_URL: 'http://localhost:5432/db' })),
    ).toThrow(/Invalid environment configuration/);

    expect(() =>
      validateEnv(buildValidEnv({ REDIS_URL: 'http://localhost:6379' })),
    ).toThrow(/Invalid environment configuration/);
  });

  it('throws when PORT is out of TCP port range', () => {
    expect(() => validateEnv(buildValidEnv({ PORT: '0' }))).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => validateEnv(buildValidEnv({ PORT: '70000' }))).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('throws when APP_SECRET, ENCRYPTION_MASTER_KEY, or JWT secrets fail length/hex constraints', () => {
    expect(() => validateEnv(buildValidEnv({ APP_SECRET: 'too-short' }))).toThrow(
      /APP_SECRET/,
    );
    expect(() =>
      validateEnv(buildValidEnv({ ENCRYPTION_MASTER_KEY: 'not-64-hex-chars' })),
    ).toThrow(/ENCRYPTION_MASTER_KEY/);
    expect(() => validateEnv(buildValidEnv({ JWT_ACCESS_SECRET: 'short' }))).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    expect(() => validateEnv(buildValidEnv({ JWT_REFRESH_SECRET: 'short' }))).toThrow(
      /JWT_REFRESH_SECRET/,
    );
  });

  it('throws when JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical', () => {
    const sharedSecret = randomBytes(32).toString('hex');
    expect(() =>
      validateEnv(
        buildValidEnv({
          JWT_ACCESS_SECRET: sharedSecret,
          JWT_REFRESH_SECRET: sharedSecret,
        }),
      ),
    ).toThrow(/JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be distinct secrets/);
  });
});
