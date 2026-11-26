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
    ...overrides,
  };
}

describe('validateEnv', () => {
  it('parses valid configuration and coerces PORT to number', () => {
    const raw = buildValidEnv();
    const parsed = validateEnv(raw);

    expect(parsed.NODE_ENV).toBe('test');
    expect(parsed.PORT).toBe(4000);
    expect(parsed.POSTGRES_URL).toBe(raw['POSTGRES_URL']);
    expect(parsed.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('applies defaults for NODE_ENV and PORT when omitted', () => {
    const raw = buildValidEnv({ NODE_ENV: undefined, PORT: undefined });
    const parsed = validateEnv(raw);

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.PORT).toBe(3000);
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

  it('throws when APP_SECRET or ENCRYPTION_MASTER_KEY fails length/hex constraints', () => {
    expect(() => validateEnv(buildValidEnv({ APP_SECRET: 'too-short' }))).toThrow(
      /APP_SECRET/,
    );
    expect(() =>
      validateEnv(buildValidEnv({ ENCRYPTION_MASTER_KEY: 'not-64-hex-chars' })),
    ).toThrow(/ENCRYPTION_MASTER_KEY/);
  });
});
