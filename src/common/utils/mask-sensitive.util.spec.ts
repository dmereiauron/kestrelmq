import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CIRCULAR_VALUE,
  isPiiKey,
  isSensitiveKey,
  maskSensitiveData,
  maskSensitiveJsonString,
  REDACTED_VALUE,
} from './mask-sensitive.util.js';

describe('maskSensitiveData & maskSensitiveJsonString', () => {
  it('identifies all required sensitive key families, PII keys, and header variants', () => {
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

    for (const piiKey of [
      'email',
      'user_email',
      'customerEmail',
      'emailAddress',
      'phone',
      'user_phone',
      'phoneNumber',
    ]) {
      expect(isPiiKey(piiKey)).toBe(true);
    }

    for (const safeKey of ['id', 'fullName', 'workspaceId', 'slug', 'status', 'microphone']) {
      expect(isSensitiveKey(safeKey)).toBe(false);
      expect(isPiiKey(safeKey)).toBe(false);
    }
  });

  it('recursively masks nested sensitive keys and masks PII keys when maskPii is enabled', () => {
    const dynamicVal = randomBytes(16).toString('hex');
    const createdAt = new Date('2026-11-26T12:00:00.000Z');
    const invalidDate = new Date('invalid');

    const input = {
      email: 'alice@example.com',
      phone: '+15550199',
      password: dynamicVal,
      apiKey: `kmq_live_${dynamicVal}`,
      credentials: { smtpUser: 'u', smtpHost: 'mail.example.com' },
      nested: {
        token: dynamicVal,
        secret: dynamicVal,
        privateKey: dynamicVal,
        customerEmail: 'nested@example.com',
        phoneNumber: '+15550100',
        safeCount: 42,
        createdAt,
        invalidDate,
        binary: Buffer.from('hello'),
        fn: (): void => {},
        err: new Error('timeout'),
      },
      items: [{ refreshToken: dynamicVal, label: 'keep-me' }, null, undefined, true],
    };

    // Default mode: credentials masked, PII preserved for workspace-owner API views
    const maskedDefault = maskSensitiveData(input) as Record<string, unknown>;
    expect(maskedDefault['email']).toBe('alice@example.com');
    expect(maskedDefault['phone']).toBe('+15550199');
    expect(maskedDefault['password']).toBe(REDACTED_VALUE);
    expect(maskedDefault['apiKey']).toBe(REDACTED_VALUE);
    expect(maskedDefault['credentials']).toBe(REDACTED_VALUE);

    // Log mode ({ maskPii: true }): both credentials and PII masked
    const maskedWithPii = maskSensitiveData(input, { maskPii: true }) as Record<string, unknown>;
    expect(maskedWithPii['email']).toBe(REDACTED_VALUE);
    expect(maskedWithPii['phone']).toBe(REDACTED_VALUE);
    expect(maskedWithPii['password']).toBe(REDACTED_VALUE);

    const nested = maskedWithPii['nested'] as Record<string, unknown>;
    expect(nested['token']).toBe(REDACTED_VALUE);
    expect(nested['secret']).toBe(REDACTED_VALUE);
    expect(nested['privateKey']).toBe(REDACTED_VALUE);
    expect(nested['customerEmail']).toBe(REDACTED_VALUE);
    expect(nested['phoneNumber']).toBe(REDACTED_VALUE);
    expect(nested['safeCount']).toBe(42);
    expect(nested['createdAt']).toBe('2026-11-26T12:00:00.000Z');
    expect(nested['invalidDate']).toBe('Invalid Date');
    expect(nested['binary']).toBe('[Buffer 5B]');
    expect(nested['fn']).toBe('[Function]');
    expect(nested['err']).toEqual({ name: 'Error', message: 'timeout' });

    const items = maskedWithPii['items'] as unknown[];
    expect(items[0]).toEqual({ refreshToken: REDACTED_VALUE, label: 'keep-me' });
    expect(items[1]).toBeNull();
    expect(items[2]).toBeUndefined();
    expect(items[3]).toBe(true);
  });

  it('masks serialized JSON response strings while leaving non-JSON text untouched', () => {
    const rawSecret = randomBytes(12).toString('hex');
    const jsonBody = JSON.stringify({
      ok: true,
      accessToken: rawSecret,
      user: { email: 'bob@example.com', phone: '+380501112233' },
    });

    const sanitized = maskSensitiveJsonString(jsonBody, { maskPii: true });
    expect(sanitized).not.toBeNull();
    expect(JSON.parse(sanitized!)).toEqual({
      ok: true,
      accessToken: REDACTED_VALUE,
      user: { email: REDACTED_VALUE, phone: REDACTED_VALUE },
    });

    expect(maskSensitiveJsonString('Service Unavailable', { maskPii: true })).toBe(
      'Service Unavailable',
    );
    expect(maskSensitiveJsonString('{malformed-json', { maskPii: true })).toBe('{malformed-json');
    expect(maskSensitiveJsonString(null)).toBeNull();
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
