export const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;

export function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 && !FORBIDDEN_PATH_SEGMENTS.has(segment);
}

/**
 * Safely resolves a nested dot-separated path (e.g. `customer.email` or `items.0.sku`)
 * from an arbitrary value while strictly blocking prototype pollution and prototype-chain leaks.
 */
export function getByPath(source: unknown, path: string): unknown {
  if (source === null || source === undefined || typeof source !== 'object') {
    return undefined;
  }

  if (typeof path !== 'string' || path.length === 0) {
    return undefined;
  }

  const segments = path.split('.');
  let current: unknown = source;

  for (const segment of segments) {
    if (!isSafePathSegment(segment)) {
      return undefined;
    }

    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }

    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_PATTERN.test(segment) || !Object.hasOwn(current, segment)) {
        return undefined;
      }
      current = current[Number(segment)];
      continue;
    }

    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
