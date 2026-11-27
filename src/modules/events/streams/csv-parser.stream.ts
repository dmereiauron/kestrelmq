import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_MAX_CSV_ROWS = 10_000;

const ALLOWED_CSV_HEADERS = new Set([
  'event_name',
  'event',
  'recipient',
  'payload',
  'idempotency_key',
  'deliver_at',
]);

export class CsvHeaderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvHeaderValidationError';
  }
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

export class CsvRowLimitExceededError extends Error {
  readonly maxRows: number;

  constructor(maxRows: number) {
    super(`CSV row count exceeds maximum allowed limit of ${maxRows} rows`);
    this.name = 'CsvRowLimitExceededError';
    this.maxRows = maxRows;
  }
}

export interface CsvRowRecord {
  readonly rowNumber: number;
  readonly eventName: string;
  readonly rawPayload: string;
  readonly rawRecipient: string;
  readonly idempotencyKey: string;
  readonly deliverAt: string;
  readonly columnCountError?: string;
}

export interface CsvParserStreamOptions {
  readonly maxRows?: number;
  readonly highWaterMark?: number;
}

type ParserState = 'FIELD_START' | 'UNQUOTED' | 'IN_QUOTES' | 'AFTER_QUOTE' | 'ROW_CR';

interface HeaderColumnMap {
  readonly totalColumns: number;
  readonly eventIndex: number;
  readonly payloadIndex: number;
  readonly recipientIndex: number;
  readonly idempotencyKeyIndex: number;
  readonly deliverAtIndex: number;
}

export class CsvParserStream extends Transform {
  readonly #maxRows: number;
  readonly #decoder = new StringDecoder('utf8');

  #isFirstChunk = true;
  #state: ParserState = 'FIELD_START';
  #hasStartedRow = false;
  #currentField = '';
  #currentRow: string[] = [];
  #headerMap: HeaderColumnMap | null = null;
  #dataRowCount = 0;

  constructor(options: CsvParserStreamOptions = {}) {
    super({
      readableObjectMode: true,
      writableObjectMode: false,
      highWaterMark: options.highWaterMark ?? 64,
    });
    this.#maxRows = options.maxRows ?? DEFAULT_MAX_CSV_ROWS;
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let text = typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
      if (this.#isFirstChunk && text.length > 0) {
        this.#isFirstChunk = false;
        if (text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }
      }

      this.#consumeText(text);
      callback();
    } catch (error: unknown) {
      callback(error instanceof Error ? error : new CsvParseError('Invalid CSV input'));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      let remaining = this.#decoder.end();
      if (this.#isFirstChunk && remaining.length > 0) {
        this.#isFirstChunk = false;
        if (remaining.charCodeAt(0) === 0xfeff) {
          remaining = remaining.slice(1);
        }
      }

      if (remaining.length > 0) {
        this.#consumeText(remaining);
      }

      if (this.#state === 'IN_QUOTES') {
        throw new CsvParseError('Unterminated quoted field at end of CSV stream');
      }

      if (this.#hasStartedRow) {
        this.#currentRow.push(this.#currentField);
        this.#emitCompletedRow(this.#currentRow);
        this.#resetRowState();
      }

      if (this.#headerMap === null) {
        throw new CsvHeaderValidationError('CSV file is empty or missing a header row');
      }

      callback();
    } catch (error: unknown) {
      callback(error instanceof Error ? error : new CsvParseError('Invalid CSV input'));
    }
  }

  #consumeText(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;

      if (this.#state === 'ROW_CR') {
        if (ch === '\n') {
          if (this.#hasStartedRow) {
            this.#currentRow.push(this.#currentField);
            this.#emitCompletedRow(this.#currentRow);
          }
          this.#resetRowState();
          continue;
        }

        if (this.#hasStartedRow) {
          this.#currentRow.push(this.#currentField);
          this.#emitCompletedRow(this.#currentRow);
        }
        this.#resetRowState();
      }

      switch (this.#state) {
        case 'FIELD_START': {
          if (ch === '"') {
            this.#hasStartedRow = true;
            this.#state = 'IN_QUOTES';
          } else if (ch === ',') {
            this.#hasStartedRow = true;
            this.#currentRow.push('');
          } else if (ch === '\r') {
            this.#state = 'ROW_CR';
          } else if (ch === '\n') {
            if (this.#hasStartedRow) {
              this.#currentRow.push('');
              this.#emitCompletedRow(this.#currentRow);
            }
            this.#resetRowState();
          } else {
            this.#hasStartedRow = true;
            this.#currentField = ch;
            this.#state = 'UNQUOTED';
          }
          break;
        }

        case 'UNQUOTED': {
          if (ch === ',') {
            this.#currentRow.push(this.#currentField);
            this.#currentField = '';
            this.#state = 'FIELD_START';
          } else if (ch === '\r') {
            this.#state = 'ROW_CR';
          } else if (ch === '\n') {
            this.#currentRow.push(this.#currentField);
            this.#emitCompletedRow(this.#currentRow);
            this.#resetRowState();
          } else if (ch === '"') {
            throw new CsvParseError('Unescaped quote character inside unquoted CSV field');
          } else {
            this.#currentField += ch;
          }
          break;
        }

        case 'IN_QUOTES': {
          if (ch === '"') {
            this.#state = 'AFTER_QUOTE';
          } else {
            this.#currentField += ch;
          }
          break;
        }

        case 'AFTER_QUOTE': {
          if (ch === '"') {
            this.#currentField += '"';
            this.#state = 'IN_QUOTES';
          } else if (ch === ',') {
            this.#currentRow.push(this.#currentField);
            this.#currentField = '';
            this.#state = 'FIELD_START';
          } else if (ch === '\r') {
            this.#state = 'ROW_CR';
          } else if (ch === '\n') {
            this.#currentRow.push(this.#currentField);
            this.#emitCompletedRow(this.#currentRow);
            this.#resetRowState();
          } else if (ch === ' ' || ch === '\t') {
            // Allow horizontal trailing whitespace between closing quote and delimiter
          } else {
            throw new CsvParseError('Unexpected character after closing quote in CSV field');
          }
          break;
        }
      }
    }
  }

  #resetRowState(): void {
    this.#state = 'FIELD_START';
    this.#hasStartedRow = false;
    this.#currentField = '';
    this.#currentRow = [];
  }

  #emitCompletedRow(columns: readonly string[]): void {
    if (columns.length === 1 && columns[0]!.trim().length === 0) {
      return;
    }

    if (this.#headerMap === null) {
      this.#headerMap = this.#parseHeaderRow(columns);
      return;
    }

    this.#dataRowCount += 1;
    if (this.#dataRowCount > this.#maxRows) {
      throw new CsvRowLimitExceededError(this.#maxRows);
    }

    const map = this.#headerMap;
    if (columns.length !== map.totalColumns) {
      const record: CsvRowRecord = {
        rowNumber: this.#dataRowCount,
        eventName: '',
        rawPayload: '',
        rawRecipient: '',
        idempotencyKey: '',
        deliverAt: '',
        columnCountError: `Expected ${map.totalColumns} CSV columns, received ${columns.length}`,
      };
      this.push(record);
      return;
    }

    const record: CsvRowRecord = {
      rowNumber: this.#dataRowCount,
      eventName: columns[map.eventIndex] ?? '',
      rawPayload: columns[map.payloadIndex] ?? '',
      rawRecipient: map.recipientIndex >= 0 ? (columns[map.recipientIndex] ?? '') : '',
      idempotencyKey: map.idempotencyKeyIndex >= 0 ? (columns[map.idempotencyKeyIndex] ?? '') : '',
      deliverAt: map.deliverAtIndex >= 0 ? (columns[map.deliverAtIndex] ?? '') : '',
    };

    this.push(record);
  }

  #parseHeaderRow(rawColumns: readonly string[]): HeaderColumnMap {
    const normalized = rawColumns.map((col) => col.trim().toLowerCase());
    const seen = new Set<string>();

    for (const header of normalized) {
      if (header.length === 0) {
        throw new CsvHeaderValidationError('CSV header row contains an empty column name');
      }
      if (!ALLOWED_CSV_HEADERS.has(header)) {
        throw new CsvHeaderValidationError(
          `Unsupported CSV column "${header}". Allowed columns: event_name (or event), recipient, payload, idempotency_key, deliver_at`,
        );
      }
      if (seen.has(header)) {
        throw new CsvHeaderValidationError(`Duplicate CSV column "${header}"`);
      }
      seen.add(header);
    }

    if (seen.has('event_name') && seen.has('event')) {
      throw new CsvHeaderValidationError(
        'CSV header must specify either "event_name" or "event", not both',
      );
    }

    const eventIndex = normalized.includes('event_name')
      ? normalized.indexOf('event_name')
      : normalized.indexOf('event');
    const payloadIndex = normalized.indexOf('payload');

    if (eventIndex === -1 || payloadIndex === -1) {
      throw new CsvHeaderValidationError(
        'CSV header must include required columns: event_name (or event) and payload',
      );
    }

    return {
      totalColumns: normalized.length,
      eventIndex,
      payloadIndex,
      recipientIndex: normalized.indexOf('recipient'),
      idempotencyKeyIndex: normalized.indexOf('idempotency_key'),
      deliverAtIndex: normalized.indexOf('deliver_at'),
    };
  }
}
