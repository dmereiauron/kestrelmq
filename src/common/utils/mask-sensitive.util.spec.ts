import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CIRCULAR_VALUE,
  isSensitiveKey,
  maskSensitiveData,
  REDACTED_VALUE,
} from './mask-sensitive.util.js';

describe('maskSensitiveData', () => {
  it('identifies all required sensitive key families and header variants', () => {
    for (const key of [
      'password',
      'passwordHash',
      'user_password',
      'apiKey',
      'x-api-key',
      'credentials',
      'encryptedCredentials',
      'token',
      'accessToken',
      'refreshToken',
      'secret',
      'webhookSigningSecret',
      'privateKey',
      'private_key',
      'authorization',
      'Authorization',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }

    for (const safeKey of ['id', 'email', 'fullName', 'workspaceId', 'slug', 'status']) {
      expect(isSensitiveKey(safeKey)).toBe(false);
    }
  });

  it('recursively masks nested sensitive keys while preserving safe fields and special types', () => {
    const dynamicVal = randomBytes(16).toString('hex');
    const createdAt = new Date('2026-11-26T12:00:00.000Z');
    const invalidDate = new Date('invalid');

    const input = {
      email: 'alice@example.com',
      password: dynamicVal,
      apiKey: `kmq_live_${dynamicVal}`,
      credentials: { smtpUser: 'u', smtpHost: 'mail.example.com' },
      nested: {
        token: dynamicVal,
        secret: dynamicVal,
        privateKey: dynamicVal,
        safeCount: 42,
        createdAt,
        invalidDate,
        binary: Buffer.from('hello'),
        fn: (): void => {},
        err: new Error('timeout'),
      },
      items: [{ refreshToken: dynamicVal, label: 'keep-me' }, null, undefined, true],
    };

    const masked = maskSensitiveData(input) as Record<string, unknown>;
    expect(masked['email']).toBe('alice@example.com');
    expect(masked['password']).toBe(REDACTED_VALUE);
    expect(masked['apiKey']).toBe(REDACTED_VALUE);
    expect(masked['credentials']).toBe(REDACTED_VALUE);

    const nested = masked['nested'] as Record<string, unknown>;
    expect(nested['token']).toBe(REDACTED_VALUE);
    expect(nested['secret']).toBe(REDACTED_VALUE);
    expect(nested['privateKey']).toBe(REDACTED_VALUE);
    expect(nested['safeCount']).toBe(42);
    expect(nested['createdAt']).toBe('2026-11-26T12:00:00.000Z');
    expect(nested['invalidDate']).toBe('Invalid Date');
    expect(nested['binary']).toBe('[Buffer 5B]');
    expect(nested['fn']).toBe('[Function]');
    expect(nested['err']).toEqual({ name: 'Error', message: 'timeout' });

    const items = masked['items'] as unknown[];
    expect(items[0]).toEqual({ refreshToken: REDACTED_VALUE, label: 'keep-me' });
    expect(items[1]).toBeNull();
    expect(items[2]).toBeUndefined();
    expect(items[3]).toBe(true);
  });

  it('breaks circular object and array references via WeakSet without stack overflow', () => {
    const cyclicObj: Record<string, unknown> = {
      name: 'node-a',
      secret: randomBytes(8).toString('hex'),
    };
    cyclicObj['self'] = cyclicObj;

    const cyclicArr: unknown[] = ['entry'];
    cyclicArr.push(cyclicArr);
    cyclicObj['arr'] = cyclicArr;

    const masked = maskSensitiveData(cyclicObj) as Record<string, unknown>;
    expect(masked['name']).toBe('node-a');
    expect(masked['secret']).toBe(REDACTED_VALUE);
    expect(masked['self']).toBe(CIRCULAR_VALUE);
    expect(masked['arr']).toEqual(['entry', CIRCULAR_VALUE]);
  });

  it('safely handles __proto__ keys without mutating Object.prototype', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"safe":"yes"}') as unknown;
    const masked = maskSensitiveData(payload) as Record<string, unknown>;

    expect(masked['safe']).toBe('yes');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
