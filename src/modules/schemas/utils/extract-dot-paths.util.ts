import { FORBIDDEN_PATH_SEGMENTS } from '../../../common/utils/get-by-path.util.js';

const MAX_EXTRACTION_DEPTH = 16;

function collectSamplePaths(
  current: unknown,
  prefix: string,
  depth: number,
  collected: Set<string>,
): void {
  if (depth > MAX_EXTRACTION_DEPTH || current === null || current === undefined) {
    if (prefix.length > 0) {
      collected.add(prefix);
    }
    return;
  }

  if (typeof current !== 'object') {
    if (prefix.length > 0) {
      collected.add(prefix);
    }
    return;
  }

  if (Array.isArray(current)) {
    if (current.length === 0) {
      if (prefix.length > 0) {
        collected.add(prefix);
      }
      return;
    }

    const itemPrefix = prefix.length > 0 ? `${prefix}.0` : '0';
    collectSamplePaths(current[0], itemPrefix, depth + 1, collected);
    return;
  }

  const keys = Object.keys(current).filter(
    (key) => !FORBIDDEN_PATH_SEGMENTS.has(key) && Object.hasOwn(current, key),
  );

  if (keys.length === 0) {
    if (prefix.length > 0) {
      collected.add(prefix);
    }
    return;
  }

  for (const key of keys) {
    const nextPath = prefix.length > 0 ? `${prefix}.${key}` : key;
    collectSamplePaths((current as Record<string, unknown>)[key], nextPath, depth + 1, collected);
  }
}

export function extractDotPaths(samplePayload: unknown): string[] {
  if (samplePayload === null || samplePayload === undefined || typeof samplePayload !== 'object') {
    return [];
  }

  const paths = new Set<string>();
  collectSamplePaths(samplePayload, '', 0, paths);
  return [...paths].sort();
}

function collectSchemaNodePaths(
  schemaNode: unknown,
  prefix: string,
  depth: number,
  collected: Set<string>,
): void {
  if (
    depth > MAX_EXTRACTION_DEPTH ||
    schemaNode === null ||
    schemaNode === undefined ||
    typeof schemaNode !== 'object' ||
    Array.isArray(schemaNode)
  ) {
    return;
  }

  const node = schemaNode as Record<string, unknown>;
  const properties = node['properties'];
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const propRecord = properties as Record<string, unknown>;
    const propKeys = Object.keys(propRecord).filter(
      (key) => !FORBIDDEN_PATH_SEGMENTS.has(key) && Object.hasOwn(propRecord, key),
    );

    if (propKeys.length > 0) {
      for (const key of propKeys) {
        const nextPrefix = prefix.length > 0 ? `${prefix}.${key}` : key;
        collectSchemaNodePaths(propRecord[key], nextPrefix, depth + 1, collected);
      }
      return;
    }
  }

  const items = node['items'];
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    const itemPrefix = prefix.length > 0 ? `${prefix}.0` : '0';
    collectSchemaNodePaths(items, itemPrefix, depth + 1, collected);
    return;
  }

  const anyOf = node['anyOf'];
  if (Array.isArray(anyOf)) {
    const beforeSize = collected.size;
    for (const branch of anyOf) {
      collectSchemaNodePaths(branch, prefix, depth + 1, collected);
    }
    if (collected.size === beforeSize && prefix.length > 0) {
      collected.add(prefix);
    }
    return;
  }

  if (prefix.length > 0) {
    collected.add(prefix);
  }
}

export function extractSchemaDotPaths(jsonSchema: unknown): string[] {
  if (jsonSchema === null || jsonSchema === undefined || typeof jsonSchema !== 'object') {
    return [];
  }

  const paths = new Set<string>();
  collectSchemaNodePaths(jsonSchema, '', 0, paths);
  return [...paths].sort();
}
