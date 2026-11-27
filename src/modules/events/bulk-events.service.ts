import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import busboy, { type BusboyFileStream } from 'busboy';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { type Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import {
  DEFAULT_DELIVERY_MAX_ATTEMPTS,
  DELIVERIES_QUEUE,
  DELIVERY_JOB_NAMES,
  type DeliveryJobPayload,
  KESTREL_BACKOFF_TYPE,
} from '../../common/queue/queue.constants.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { DeliveryStatus, EventDirection } from '../../generated/prisma/enums.js';
import {
  type EvaluableRule,
  type MatchedRoutingRuleRecord,
  RulesService,
} from '../rules/rules.service.js';
import { EventSchemasService } from '../schemas/event-schemas.service.js';
import {
  CsvHeaderValidationError,
  CsvParseError,
  CsvParserStream,
  type CsvRowRecord,
  CsvRowLimitExceededError,
  DEFAULT_MAX_CSV_ROWS,
} from './streams/csv-parser.stream.js';

export const BULK_CHUNK_SIZE = 500;
export const DEFAULT_MAX_BULK_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_REPORTED_BULK_ROW_ERRORS = 100;

const MAX_EVENT_NAME_LEN = 128;
const MAX_IDEMPOTENCY_KEY_LEN = 255;
const STRICT_ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface BulkRowValidationError {
  readonly row: number;
  readonly message: string;
}

export interface BulkIngestResponse {
  readonly totalRows: number;
  readonly importedEvents: number;
  readonly createdDeliveries: number;
  readonly skippedDuplicates: number;
  readonly failedRows: number;
  readonly errors: readonly BulkRowValidationError[];
}

export interface BulkIngestOptions {
  readonly maxFileBytes?: number;
  readonly maxRows?: number;
  readonly chunkSize?: number;
}

interface EvaluableMatchedRule extends EvaluableRule {
  readonly record: MatchedRoutingRuleRecord;
}

interface ValidatedCsvEventRow {
  readonly rowNumber: number;
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly recipient: Record<string, unknown>;
  readonly idempotencyKey: string | null;
  readonly scheduledFor: Date | null;
  readonly delayMs: number;
  readonly schemaWarnings: Prisma.InputJsonValue | null;
}

function toPrismaJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function extractExceptionMessage(error: unknown): string {
  if (error instanceof BadRequestException) {
    const response = error.getResponse();
    if (typeof response === 'string') {
      return response;
    }
    if (typeof response === 'object' && response !== null) {
      const msg = (response as Record<string, unknown>)['message'];
      if (Array.isArray(msg)) {
        return msg.filter((item): item is string => typeof item === 'string').join('; ');
      }
      if (typeof msg === 'string' && msg.length > 0) {
        return msg;
      }
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Row validation failed';
}

function parseJsonPlainObject(raw: string, fieldLabel: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${fieldLabel} must be valid JSON`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fieldLabel} must be a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

@Injectable()
export class BulkEventsService {
  readonly #prismaService: PrismaService;
  readonly #eventSchemasService: EventSchemasService;
  readonly #rulesService: RulesService;
  readonly #deliveriesQueue: Queue<DeliveryJobPayload, unknown, string>;

  constructor(
    prismaService: PrismaService,
    eventSchemasService: EventSchemasService,
    rulesService: RulesService,
    @InjectQueue(DELIVERIES_QUEUE) deliveriesQueue: Queue<DeliveryJobPayload, unknown, string>,
  ) {
    this.#prismaService = prismaService;
    this.#eventSchemasService = eventSchemasService;
    this.#rulesService = rulesService;
    this.#deliveriesQueue = deliveriesQueue;
  }

  async ingestMultipartStream(
    workspaceId: string,
    request: Readable & { readonly headers: IncomingHttpHeaders },
    options: BulkIngestOptions = {},
  ): Promise<BulkIngestResponse> {
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_BULK_FILE_BYTES;
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('multipart/form-data')) {
      throw new BadRequestException('Content-Type must be multipart/form-data');
    }

    const contentLengthHeader = request.headers['content-length'];
    if (typeof contentLengthHeader === 'string' && /^\d+$/.test(contentLengthHeader.trim())) {
      const declaredBytes = Number.parseInt(contentLengthHeader.trim(), 10);
      if (declaredBytes > maxFileBytes) {
        throw new PayloadTooLargeException(
          `Uploaded payload exceeds maximum allowed size of ${maxFileBytes} bytes`,
        );
      }
    }

    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({
        headers: request.headers,
        limits: {
          fileSize: maxFileBytes + 1,
          files: 1,
          fields: 5,
        },
      });
    } catch {
      throw new BadRequestException('Malformed multipart/form-data headers');
    }

    let fileSeen = false;
    let fileIngestionPromise: Promise<BulkIngestResponse> | null = null;
    let multipartError: Error | null = null;
    const abortSignal = { aborted: false };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const failOnce = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        abortSignal.aborted = true;
        queueMicrotask(() => {
          request.unpipe(bb);
          bb.destroy();
        });
        reject(err);
      };

      bb.on('filesLimit', () => {
        multipartError ??= new BadRequestException('Only one CSV file may be uploaded per request');
      });

      bb.on('fieldsLimit', () => {
        multipartError ??= new BadRequestException('Too many multipart form fields');
      });

      bb.on('file', (_fieldName: string, fileStream: BusboyFileStream) => {
        if (fileSeen) {
          fileStream.resume();
          multipartError ??= new BadRequestException(
            'Only one CSV file may be uploaded per request',
          );
          return;
        }

        fileSeen = true;
        fileStream.on('limit', () => {
          const sizeErr = new PayloadTooLargeException(
            `CSV file exceeds maximum allowed size of ${maxFileBytes} bytes`,
          );
          multipartError = sizeErr;
          fileStream.resume();
          failOnce(sizeErr);
        });

        const ingestion = this.ingestCsvStream(workspaceId, fileStream, options, abortSignal);
        fileIngestionPromise = ingestion;
        ingestion.catch((err: unknown) => {
          fileStream.resume();
          failOnce(
            multipartError ??
              (err instanceof Error ? err : new BadRequestException('Bulk CSV ingestion failed')),
          );
        });
      });

      bb.once('close', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      bb.once('error', (err: unknown) => {
        failOnce(
          multipartError ??
            (err instanceof Error ? err : new BadRequestException('Multipart stream error')),
        );
      });

      request.once('error', (err: Error) => {
        failOnce(err);
      });

      request.pipe(bb);
    }).catch((err: unknown) => {
      if (multipartError !== null) {
        throw multipartError;
      }
      if (err instanceof PayloadTooLargeException || err instanceof BadRequestException) {
        throw err;
      }
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid multipart/form-data upload stream',
      );
    });

    if (multipartError !== null) {
      throw multipartError;
    }

    if (!fileSeen || fileIngestionPromise === null) {
      throw new BadRequestException('Missing CSV file part in multipart/form-data payload');
    }

    return fileIngestionPromise;
  }

  async ingestCsvStream(
    workspaceId: string,
    csvStream: Readable,
    options: BulkIngestOptions = {},
    abortState: { readonly aborted: boolean } = { aborted: false },
  ): Promise<BulkIngestResponse> {
    const maxRows = options.maxRows ?? DEFAULT_MAX_CSV_ROWS;
    const chunkSize = options.chunkSize ?? BULK_CHUNK_SIZE;

    let totalRows = 0;
    let importedEvents = 0;
    let createdDeliveries = 0;
    let skippedDuplicates = 0;
    let failedRows = 0;
    const errors: BulkRowValidationError[] = [];
    const seenIdempotencyKeys = new Set<string>();
    const rulesCache = new Map<string, EvaluableMatchedRule[]>();
    const pendingBatch: ValidatedCsvEventRow[] = [];

    const recordRowError = (row: number, message: string): void => {
      failedRows += 1;
      if (errors.length < MAX_REPORTED_BULK_ROW_ERRORS) {
        errors.push({ row, message });
      }
    };

    const flushBatch = async (batch: readonly ValidatedCsvEventRow[]): Promise<void> => {
      if (batch.length === 0 || abortState.aborted) {
        return;
      }

      const result = await this.#persistAndEnqueueChunk(
        workspaceId,
        batch,
        seenIdempotencyKeys,
        rulesCache,
      );
      importedEvents += result.importedEvents;
      createdDeliveries += result.createdDeliveries;
      skippedDuplicates += result.skippedDuplicates;
    };

    const parserStream = new CsvParserStream({ maxRows });

    const sinkStream = new Writable({
      objectMode: true,
      highWaterMark: 16,
      write: (record: CsvRowRecord, _encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
        void (async () => {
          totalRows += 1;

          if (record.columnCountError !== undefined) {
            recordRowError(record.rowNumber, record.columnCountError);
            return;
          }

          const validated = await this.#validateCsvRow(workspaceId, record, recordRowError);
          if (validated === null) {
            return;
          }

          pendingBatch.push(validated);
          if (pendingBatch.length >= chunkSize) {
            const chunk = pendingBatch.splice(0, chunkSize);
            await flushBatch(chunk);
          }
        })().then(
          () => callback(),
          (err: unknown) =>
            callback(err instanceof Error ? err : new Error('Bulk chunk processing failed')),
        );
      },
      final: (callback: (error?: Error | null) => void) => {
        void (async () => {
          if (pendingBatch.length > 0) {
            const remainder = pendingBatch.splice(0, pendingBatch.length);
            await flushBatch(remainder);
          }
        })().then(
          () => callback(),
          (err: unknown) =>
            callback(err instanceof Error ? err : new Error('Bulk final flush failed')),
        );
      },
    });

    try {
      await pipeline(csvStream, parserStream, sinkStream);
    } catch (error: unknown) {
      if (error instanceof PayloadTooLargeException || error instanceof BadRequestException) {
        throw error;
      }
      if (error instanceof CsvRowLimitExceededError) {
        throw new PayloadTooLargeException(error.message);
      }
      if (error instanceof CsvHeaderValidationError || error instanceof CsvParseError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    if (totalRows === 0) {
      throw new BadRequestException('CSV file contains no event data rows');
    }

    return {
      totalRows,
      importedEvents,
      createdDeliveries,
      skippedDuplicates,
      failedRows,
      errors,
    };
  }

  async #validateCsvRow(
    workspaceId: string,
    record: CsvRowRecord,
    onRowError: (row: number, message: string) => void,
  ): Promise<ValidatedCsvEventRow | null> {
    const eventName = record.eventName.trim();
    if (
      eventName.length === 0 ||
      eventName.length > MAX_EVENT_NAME_LEN ||
      /\s/.test(eventName)
    ) {
      onRowError(
        record.rowNumber,
        `event_name must be a non-empty identifier (max ${MAX_EVENT_NAME_LEN} chars) without whitespace`,
      );
      return null;
    }

    const rawPayloadTrimmed = record.rawPayload.trim();
    if (rawPayloadTrimmed.length === 0) {
      onRowError(record.rowNumber, 'payload must be a non-empty JSON object');
      return null;
    }

    let payload: Record<string, unknown>;
    try {
      payload = parseJsonPlainObject(rawPayloadTrimmed, 'payload');
    } catch (error: unknown) {
      onRowError(record.rowNumber, error instanceof Error ? error.message : 'Invalid payload JSON');
      return null;
    }

    let recipient: Record<string, unknown> = {};
    const rawRecipientTrimmed = record.rawRecipient.trim();
    if (rawRecipientTrimmed.length > 0) {
      try {
        recipient = parseJsonPlainObject(rawRecipientTrimmed, 'recipient');
      } catch (error: unknown) {
        onRowError(
          record.rowNumber,
          error instanceof Error ? error.message : 'Invalid recipient JSON',
        );
        return null;
      }
    }

    let idempotencyKey: string | null = null;
    const trimmedIdempotencyKey = record.idempotencyKey.trim();
    if (trimmedIdempotencyKey.length > 0) {
      if (trimmedIdempotencyKey.length > MAX_IDEMPOTENCY_KEY_LEN || /\s/.test(trimmedIdempotencyKey)) {
        onRowError(
          record.rowNumber,
          `idempotency_key must be between 1 and ${MAX_IDEMPOTENCY_KEY_LEN} non-whitespace characters`,
        );
        return null;
      }
      idempotencyKey = trimmedIdempotencyKey;
    }

    let scheduledFor: Date | null = null;
    let delayMs = 0;
    const trimmedDeliverAt = record.deliverAt.trim();
    if (trimmedDeliverAt.length > 0) {
      const parsedDate = new Date(trimmedDeliverAt);
      if (!STRICT_ISO_8601_PATTERN.test(trimmedDeliverAt) || Number.isNaN(parsedDate.getTime())) {
        onRowError(record.rowNumber, 'deliver_at must be a valid ISO-8601 timestamp');
        return null;
      }
      scheduledFor = parsedDate;
      delayMs = Math.max(0, parsedDate.getTime() - Date.now());
    }

    let schemaWarnings: Prisma.InputJsonValue | null = null;
    try {
      const validation = await this.#eventSchemasService.validatePayload(
        workspaceId,
        eventName,
        payload,
      );
      if (validation.warnings !== null && validation.warnings.length > 0) {
        schemaWarnings = toPrismaJsonValue(validation.warnings);
      }
    } catch (error: unknown) {
      onRowError(record.rowNumber, extractExceptionMessage(error));
      return null;
    }

    return {
      rowNumber: record.rowNumber,
      eventName,
      payload,
      recipient,
      idempotencyKey,
      scheduledFor,
      delayMs,
      schemaWarnings,
    };
  }

  async #getCandidateRulesForEvent(
    workspaceId: string,
    eventName: string,
    cache: Map<string, EvaluableMatchedRule[]>,
  ): Promise<EvaluableMatchedRule[]> {
    const cached = cache.get(eventName);
    if (cached !== undefined) {
      return cached;
    }

    const dbRules = await this.#rulesService.findMatchingRules(workspaceId, eventName);
    const mapped: EvaluableMatchedRule[] = dbRules.map((rule) => ({
      id: rule.id,
      eventName: rule.eventName,
      channel: rule.integration.channel,
      targetOverride: rule.targetOverride,
      isActive: rule.isActive,
      record: rule,
    }));
    cache.set(eventName, mapped);
    return mapped;
  }

  async #persistAndEnqueueChunk(
    workspaceId: string,
    batch: readonly ValidatedCsvEventRow[],
    seenIdempotencyKeys: Set<string>,
    rulesCache: Map<string, EvaluableMatchedRule[]>,
  ): Promise<{
    readonly importedEvents: number;
    readonly createdDeliveries: number;
    readonly skippedDuplicates: number;
  }> {
    let skippedDuplicates = 0;
    const deduplicatedRows: ValidatedCsvEventRow[] = [];
    const candidateDbKeys: string[] = [];

    for (const row of batch) {
      if (row.idempotencyKey !== null) {
        if (seenIdempotencyKeys.has(row.idempotencyKey)) {
          skippedDuplicates += 1;
          continue;
        }
        seenIdempotencyKeys.add(row.idempotencyKey);
        candidateDbKeys.push(row.idempotencyKey);
      }
      deduplicatedRows.push(row);
    }

    if (deduplicatedRows.length === 0) {
      return { importedEvents: 0, createdDeliveries: 0, skippedDuplicates };
    }

    const distinctEvents = new Set(deduplicatedRows.map((row) => row.eventName));
    for (const eventName of distinctEvents) {
      await this.#getCandidateRulesForEvent(workspaceId, eventName, rulesCache);
    }

    const txResult = await this.#prismaService.$transaction(async (tx) => {
      const existingDbKeySet = new Set<string>();
      if (candidateDbKeys.length > 0) {
        const existingEvents = await tx.event.findMany({
          where: {
            workspaceId,
            idempotencyKey: { in: candidateDbKeys },
          },
          select: { idempotencyKey: true },
        });
        for (const item of existingEvents) {
          if (item.idempotencyKey !== null) {
            existingDbKeySet.add(item.idempotencyKey);
          }
        }
      }

      const eventCreates: Prisma.EventCreateManyInput[] = [];
      const deliveryCreates: Prisma.DeliveryCreateManyInput[] = [];
      const jobsToEnqueue: {
        name: string;
        data: DeliveryJobPayload;
        opts: {
          jobId: string;
          attempts: number;
          backoff: { type: string };
          delay?: number;
        };
      }[] = [];

      let dbDuplicatesCount = 0;

      for (const row of deduplicatedRows) {
        if (row.idempotencyKey !== null && existingDbKeySet.has(row.idempotencyKey)) {
          dbDuplicatesCount += 1;
          continue;
        }

        const eventId = randomUUID();
        const isDelayed = row.delayMs > 0;
        const initialStatus = isDelayed ? DeliveryStatus.SCHEDULED : DeliveryStatus.PENDING;

        eventCreates.push({
          id: eventId,
          workspaceId,
          idempotencyKey: row.idempotencyKey,
          eventName: row.eventName,
          recipient: toPrismaJsonObject(row.recipient),
          payload: toPrismaJsonObject(row.payload),
          scheduledFor: row.scheduledFor,
          ...(row.schemaWarnings !== null ? { schemaWarnings: row.schemaWarnings } : {}),
          direction: EventDirection.OUTBOUND,
        });

        const candidateRules = rulesCache.get(row.eventName) ?? [];
        const matchedRules = this.#rulesService.evaluateRules(candidateRules, {
          eventName: row.eventName,
          payload: row.payload,
          recipient: row.recipient,
        });

        for (const match of matchedRules) {
          const deliveryId = randomUUID();
          deliveryCreates.push({
            id: deliveryId,
            workspaceId,
            eventId,
            routingRuleId: match.rule.record.id,
            integrationId: match.rule.record.integrationId,
            status: initialStatus,
            maxAttempts: DEFAULT_DELIVERY_MAX_ATTEMPTS,
          });

          jobsToEnqueue.push({
            name: DELIVERY_JOB_NAMES.DELIVER_OUTBOUND,
            data: {
              deliveryId,
              workspaceId,
              eventId,
            },
            opts: {
              jobId: deliveryId,
              attempts: DEFAULT_DELIVERY_MAX_ATTEMPTS,
              backoff: { type: KESTREL_BACKOFF_TYPE },
              ...(isDelayed ? { delay: row.delayMs } : {}),
            },
          });
        }
      }

      if (eventCreates.length > 0) {
        await tx.event.createMany({ data: eventCreates });
      }
      if (deliveryCreates.length > 0) {
        await tx.delivery.createMany({ data: deliveryCreates });
      }

      return {
        importedCount: eventCreates.length,
        deliveriesCount: deliveryCreates.length,
        dbDuplicatesCount,
        jobsToEnqueue,
      };
    });

    if (txResult.jobsToEnqueue.length > 0) {
      await this.#deliveriesQueue.addBulk(txResult.jobsToEnqueue);
    }

    return {
      importedEvents: txResult.importedCount,
      createdDeliveries: txResult.deliveriesCount,
      skippedDuplicates: skippedDuplicates + txResult.dbDuplicatesCount,
    };
  }
}
