export const REDACTED_VALUE = '[REDACTED]' as const;
export const CIRCULAR_VALUE = '[Circular]' as const;

const SENSITIVE_KEY_TOKENS = [
  'password',
  'apikey',
  'credentials',
  'token',
  'secret',
  'privatekey',
] as const;

/**
 * Checks whether an object/header property name matches any sensitive key family
 * (`password`, `apiKey`, `credentials`, `token`, `secret`, `privateKey`, or `authorization`).
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  if (normalized === 'authorization') {
    return true;
  }
  return SENSITIVE_KEY_TOKENS.some((token) => normalized.includes(token));
}

function setSafeProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return;
  }
  target[key] = value;
}

/**
 * Recursively clones data for safe logging/auditing, masking sensitive keys as `'[REDACTED]'`
 * and breaking circular object/array graphs using a `WeakSet<object>`.
 */
export function maskSensitiveData(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'function') {
    return '[Function]';
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.byteLength}B]`;
  }

  if (seen.has(value)) {
    return CIRCULAR_VALUE;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => maskSensitiveData(entry, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  const masked: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      setSafeProperty(masked, key, REDACTED_VALUE);
    } else {
      setSafeProperty(masked, key, maskSensitiveData(nestedValue, seen));
    }
  }

  return masked;
}
