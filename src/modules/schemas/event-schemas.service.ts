import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Ajv, type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { SchemaValidationMode } from '../../generated/prisma/enums.js';
import type { UpdateEventSchemaDto } from './dto/update-event-schema.dto.js';
import type { UpsertEventSchemaDto } from './dto/upsert-event-schema.dto.js';
import { extractDotPaths, extractSchemaDotPaths } from './utils/extract-dot-paths.util.js';
import { type InferredJsonSchema, inferJsonSchema } from './utils/infer-json-schema.util.js';

const addFormats: FormatsPlugin =
  typeof addFormatsModule === 'function'
    ? addFormatsModule
    : (addFormatsModule as unknown as { default: FormatsPlugin }).default;

export interface InferSchemaResponse {
  readonly jsonSchema: InferredJsonSchema;
  readonly variables: readonly string[];
}

export interface EventSchemaResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventName: string;
  readonly samplePayload: Prisma.JsonValue;
  readonly jsonSchema: Prisma.JsonValue;
  readonly validationMode: SchemaValidationMode;
  readonly variables: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SchemaValidationIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export interface PayloadValidationResult {
  readonly valid: boolean;
  readonly mode: SchemaValidationMode;
  readonly warnings: readonly SchemaValidationIssue[] | null;
}

const MAX_VALIDATOR_CACHE_SIZE = 500;

function toPrismaJsonObject(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function formatAjvIssues(errors: readonly ErrorObject[] | null | undefined): SchemaValidationIssue[] {
  if (!errors || errors.length === 0) {
    return [];
  }

  return errors.map((err) => ({
    instancePath: err.instancePath,
    schemaPath: err.schemaPath,
    keyword: err.keyword,
    message: err.message ?? 'Schema validation failed',
  }));
}

function computeSchemaVariables(samplePayload: unknown, jsonSchema: unknown): string[] {
  const merged = new Set<string>([
    ...extractDotPaths(samplePayload),
    ...extractSchemaDotPaths(jsonSchema),
  ]);
  return [...merged].sort();
}

@Injectable()
export class EventSchemasService {
  readonly #prismaService: PrismaService;
  readonly #ajv: Ajv;
  readonly #validatorCache = new Map<string, ValidateFunction>();

  constructor(prismaService: PrismaService) {
    this.#prismaService = prismaService;
    this.#ajv = new Ajv({
      allErrors: true,
      strict: false,
    });
    addFormats(this.#ajv);
  }

  inferFromSample(samplePayload: Record<string, unknown>): InferSchemaResponse {
    const jsonSchema = inferJsonSchema(samplePayload);
    const variables = computeSchemaVariables(samplePayload, jsonSchema);
    return {
      jsonSchema,
      variables,
    };
  }

  async upsertSchema(
    workspaceId: string,
    dto: UpsertEventSchemaDto,
  ): Promise<EventSchemaResponse> {
    const eventName = dto.eventName.trim();
    if (eventName.length === 0 || /\s/.test(eventName)) {
      throw new BadRequestException(
        'eventName must be a non-empty identifier without whitespace',
      );
    }

    const resolvedSchema = dto.jsonSchema ?? inferJsonSchema(dto.samplePayload);
    this.#assertCompilableJsonSchema(resolvedSchema);

    const sampleJson = toPrismaJsonObject(dto.samplePayload);
    const schemaJson = toPrismaJsonObject(resolvedSchema);
    const validationMode = dto.validationMode ?? SchemaValidationMode.DISABLED;

    const saved = await this.#prismaService.eventSchema.upsert({
      where: {
        workspaceId_eventName: {
          workspaceId,
          eventName,
        },
      },
      create: {
        workspaceId,
        eventName,
        samplePayload: sampleJson,
        jsonSchema: schemaJson,
        validationMode,
      },
      update: {
        samplePayload: sampleJson,
        jsonSchema: schemaJson,
        ...(dto.validationMode !== undefined ? { validationMode: dto.validationMode } : {}),
      },
    });

    return this.#toSchemaResponse(saved);
  }

  async listSchemas(workspaceId: string): Promise<EventSchemaResponse[]> {
    const records = await this.#prismaService.eventSchema.findMany({
      where: { workspaceId },
      orderBy: { eventName: 'asc' },
    });

    return records.map((record) => this.#toSchemaResponse(record));
  }

  async updateSchema(
    workspaceId: string,
    schemaId: string,
    dto: UpdateEventSchemaDto,
  ): Promise<EventSchemaResponse> {
    const existing = await this.#prismaService.eventSchema.findFirst({
      where: {
        id: schemaId,
        workspaceId,
      },
    });

    if (!existing) {
      throw new NotFoundException('Event schema not found');
    }

    const updateData: {
      samplePayload?: Prisma.InputJsonObject;
      jsonSchema?: Prisma.InputJsonObject;
      validationMode?: SchemaValidationMode;
    } = {};

    if (dto.samplePayload !== undefined) {
      updateData.samplePayload = toPrismaJsonObject(dto.samplePayload);
      if (dto.jsonSchema === undefined) {
        const reInferred = inferJsonSchema(dto.samplePayload);
        this.#assertCompilableJsonSchema(reInferred);
        updateData.jsonSchema = toPrismaJsonObject(reInferred);
      }
    }

    if (dto.jsonSchema !== undefined) {
      this.#assertCompilableJsonSchema(dto.jsonSchema);
      updateData.jsonSchema = toPrismaJsonObject(dto.jsonSchema);
    }

    if (dto.validationMode !== undefined) {
      updateData.validationMode = dto.validationMode;
    }

    const updated = await this.#prismaService.eventSchema.update({
      where: { id: existing.id },
      data: updateData,
    });

    return this.#toSchemaResponse(updated);
  }

  async deleteSchema(workspaceId: string, schemaId: string): Promise<void> {
    const deleted = await this.#prismaService.eventSchema.deleteMany({
      where: {
        id: schemaId,
        workspaceId,
      },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Event schema not found');
    }
  }

  async validateEventPayload(
    workspaceId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<PayloadValidationResult> {
    const schemaRecord = await this.#prismaService.eventSchema.findUnique({
      where: {
        workspaceId_eventName: {
          workspaceId,
          eventName,
        },
      },
    });

    if (!schemaRecord || schemaRecord.validationMode === SchemaValidationMode.DISABLED) {
      return {
        valid: true,
        mode: SchemaValidationMode.DISABLED,
        warnings: null,
      };
    }

    const validateFn = this.#getOrCompileValidator(
      schemaRecord.id,
      schemaRecord.updatedAt,
      schemaRecord.jsonSchema,
    );

    const isValid = validateFn(payload);
    if (isValid) {
      return {
        valid: true,
        mode: schemaRecord.validationMode,
        warnings: null,
      };
    }

    const issues = formatAjvIssues(validateFn.errors);

    if (schemaRecord.validationMode === SchemaValidationMode.WARN) {
      return {
        valid: false,
        mode: SchemaValidationMode.WARN,
        warnings: issues,
      };
    }

    // STRICT mode: reject with 400 Bad Request + detailed Ajv validation messages (SPEC.md §3.2 Step 3)
    const detailedMessages =
      issues.length > 0
        ? issues.map(
            (issue) => `payload${issue.instancePath || ''} ${issue.message} (${issue.keyword})`,
          )
        : ['Payload failed strict JSON Schema validation'];

    throw new BadRequestException(detailedMessages);
  }

  #assertCompilableJsonSchema(candidateSchema: unknown): void {
    if (
      candidateSchema === null ||
      typeof candidateSchema !== 'object' ||
      Array.isArray(candidateSchema)
    ) {
      throw new BadRequestException('jsonSchema must be a valid JSON Schema object');
    }

    try {
      const validMeta = this.#ajv.validateSchema(candidateSchema as AnySchemaObject);
      if (!validMeta) {
        const details = formatAjvIssues(this.#ajv.errors)
          .map((issue) => `${issue.instancePath || '/'} ${issue.message}`)
          .join('; ');
        throw new BadRequestException(
          `Invalid JSON Schema definition${details ? `: ${details}` : ''}`,
        );
      }
      this.#ajv.compile(candidateSchema as AnySchemaObject);
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : 'Unable to compile JSON Schema';
      throw new BadRequestException(`Invalid JSON Schema definition: ${reason}`);
    }
  }

  #getOrCompileValidator(
    schemaId: string,
    updatedAt: Date,
    jsonSchema: Prisma.JsonValue,
  ): ValidateFunction {
    const cacheKey = `${schemaId}:${updatedAt.getTime()}`;
    const cached = this.#validatorCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const compiled = this.#ajv.compile(jsonSchema as AnySchemaObject);

    if (this.#validatorCache.size >= MAX_VALIDATOR_CACHE_SIZE) {
      const oldestKey = this.#validatorCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.#validatorCache.delete(oldestKey);
      }
    }

    this.#validatorCache.set(cacheKey, compiled);
    return compiled;
  }

  #toSchemaResponse(record: {
    id: string;
    workspaceId: string;
    eventName: string;
    samplePayload: Prisma.JsonValue;
    jsonSchema: Prisma.JsonValue;
    validationMode: SchemaValidationMode;
    createdAt: Date;
    updatedAt: Date;
  }): EventSchemaResponse {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      eventName: record.eventName,
      samplePayload: record.samplePayload,
      jsonSchema: record.jsonSchema,
      validationMode: record.validationMode,
      variables: computeSchemaVariables(record.samplePayload, record.jsonSchema),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
