import { FORBIDDEN_PATH_SEGMENTS } from '../../../common/utils/get-by-path.util.js';

export interface InferredJsonSchema {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  readonly format?: 'uuid' | 'date-time' | 'date' | 'email' | 'uri';
  readonly properties?: Readonly<Record<string, InferredJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: InferredJsonSchema;
  readonly anyOf?: readonly InferredJsonSchema[];
}

const MAX_INFERENCE_DEPTH = 16;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI_REGEX = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

function detectStringFormat(
  value: string,
): 'uuid' | 'date-time' | 'date' | 'email' | 'uri' | undefined {
  if (UUID_REGEX.test(value)) {
    return 'uuid';
  }
  if (ISO_DATE_TIME_REGEX.test(value)) {
    return 'date-time';
  }
  if (ISO_DATE_REGEX.test(value)) {
    return 'date';
  }
  if (EMAIL_REGEX.test(value)) {
    return 'email';
  }
  if (URI_REGEX.test(value)) {
    return 'uri';
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deduplicateSchemas(schemas: readonly InferredJsonSchema[]): InferredJsonSchema[] {
  const unique = new Map<string, InferredJsonSchema>();
  for (const schema of schemas) {
    const signature = JSON.stringify(schema);
    if (!unique.has(signature)) {
      unique.set(signature, schema);
    }
  }
  return [...unique.values()];
}

function mergeObjectItemSchemas(
  items: ReadonlyArray<Record<string, unknown>>,
  depth: number,
): InferredJsonSchema {
  const allKeys = new Set<string>();
  const keyPresenceCounts = new Map<string, number>();
  const propertyCandidates = new Map<string, InferredJsonSchema[]>();

  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (FORBIDDEN_PATH_SEGMENTS.has(key) || !Object.hasOwn(item, key)) {
        continue;
      }
      const propValue = item[key];
      if (propValue === undefined) {
        continue;
      }

      allKeys.add(key);
      keyPresenceCounts.set(key, (keyPresenceCounts.get(key) ?? 0) + 1);
      const list = propertyCandidates.get(key) ?? [];
      list.push(inferNode(propValue, depth + 1));
      propertyCandidates.set(key, list);
    }
  }

  const properties: Record<string, InferredJsonSchema> = {};
  const required: string[] = [];

  for (const key of [...allKeys].sort()) {
    const candidates = deduplicateSchemas(propertyCandidates.get(key) ?? []);
    properties[key] =
      candidates.length === 1 ? candidates[0]! : { anyOf: candidates };

    if (keyPresenceCounts.get(key) === items.length) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

function inferNode(value: unknown, depth: number): InferredJsonSchema {
  if (depth > MAX_INFERENCE_DEPTH) {
    return {};
  }

  if (value === null) {
    return { type: 'null' };
  }

  switch (typeof value) {
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'string': {
      const format = detectStringFormat(value);
      return format ? { type: 'string', format } : { type: 'string' };
    }
    case 'object': {
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return { type: 'array' };
        }
        if (value.every((entry) => isPlainRecord(entry))) {
          return {
            type: 'array',
            items: mergeObjectItemSchemas(value, depth + 1),
          };
        }
        const uniqueItems = deduplicateSchemas(
          value.map((entry) => inferNode(entry, depth + 1)),
        );
        return {
          type: 'array',
          items: uniqueItems.length === 1 ? uniqueItems[0]! : { anyOf: uniqueItems },
        };
      }

      const record = value as Record<string, unknown>;
      const properties: Record<string, InferredJsonSchema> = {};
      const required: string[] = [];

      for (const key of Object.keys(record).sort()) {
        if (FORBIDDEN_PATH_SEGMENTS.has(key) || !Object.hasOwn(record, key)) {
          continue;
        }
        const propValue = record[key];
        if (propValue === undefined) {
          continue;
        }
        properties[key] = inferNode(propValue, depth + 1);
        if (propValue !== null) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: true,
      };
    }
    default:
      return {};
  }
}

export function inferJsonSchema(samplePayload: unknown): InferredJsonSchema {
  return inferNode(samplePayload, 0);
}
