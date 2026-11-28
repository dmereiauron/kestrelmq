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

export interface MaskSensitiveOptions {
  readonly maskPii?: boolean;
}

/**
 * Checks whether an object/header property name matches any sensitive credential key family
 * (`password`, `apiKey`, `credentials`, `token`, `secret`, `privateKey`, or `authorization`).
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  if (normalized === 'authorization') {
    return true;
  }
  return SENSITIVE_KEY_TOKENS.some((token) => normalized.includes(token));
}

/**
 * Checks whether an object/header property name represents a PII field (`email` or `phone` word tokens).
 */
export function isPiiKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some(
    (word) => word === 'email' || word === 'emails' || word === 'phone' || word === 'phones',
  );
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
 * Recursively clones data for safe logging/auditing, masking sensitive keys (and optionally PII keys
 * such as `email` and `phone` when `options.maskPii` is enabled) as `'[REDACTED]'` while breaking
 * circular object/array graphs using a `WeakSet<object>`.
 */
export function maskSensitiveData(
  value: unknown,
  options: MaskSensitiveOptions = {},
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
    return value.map((entry) => maskSensitiveData(entry, options, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  const masked: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key) || (options.maskPii === true && isPiiKey(key))) {
      setSafeProperty(masked, key, REDACTED_VALUE);
    } else {
      setSafeProperty(masked, key, maskSensitiveData(nestedValue, options, seen));
    }
  }

  return masked;
}

/**
 * Parses a serialized JSON response string (if valid JSON object/array), recursively masks sensitive
 * and optional PII keys via `maskSensitiveData`, and re-serializes it. Non-JSON text is returned unchanged.
 */
export function maskSensitiveJsonString(
  raw: string | null | undefined,
  options: MaskSensitiveOptions = {},
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  if (
    !(trimmed.startsWith('{') && trimmed.endsWith('}')) &&
    !(trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return raw;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      return JSON.stringify(maskSensitiveData(parsed, options));
    }
    return raw;
  } catch {
    return raw;
  }
}
