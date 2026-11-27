import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  CsvHeaderValidationError,
  CsvParseError,
  CsvParserStream,
  type CsvRowRecord,
  CsvRowLimitExceededError,
} from './csv-parser.stream.js';

async function parseChunks(
  chunks: readonly (Buffer | string)[],
  maxRows?: number,
): Promise<CsvRowRecord[]> {
  const rows: CsvRowRecord[] = [];
  const parser = new CsvParserStream({ maxRows });
  const sink = new Writable({
    objectMode: true,
    write(record: CsvRowRecord, _encoding, callback) {
      rows.push(record);
      callback();
    },
  });

  await pipeline(Readable.from(chunks), parser, sink);
  return rows;
}

describe('CsvParserStream', () => {
  it('parses RFC 4180 CSV with quoted JSON fields, escaped quotes, CRLF, and embedded newlines across arbitrary byte chunks', async () => {
    const csv =
      '\uFEFFevent_name,recipient,payload,idempotency_key,deliver_at\r\n' +
      'order.paid,"{""email"":""alice@example.com""}","{""orderId"":""ord_1"",""note"":""Line 1\nLine 2, with comma""}",idem-1,2026-12-01T10:00:00.000Z\r\n' +
      '\r\n' +
      'user.signup,,"{""plan"":""PRO"",""greeting"":""Привіт 🚀""}",,\r\n';

    const fullBuffer = Buffer.from(csv, 'utf8');
    // Slice at 7-byte boundaries to split multi-byte UTF-8 characters and CRLF pairs mid-sequence
    const tinyChunks: Buffer[] = [];
    for (let offset = 0; offset < fullBuffer.length; offset += 7) {
      tinyChunks.push(fullBuffer.subarray(offset, offset + 7));
    }

    const rows = await parseChunks(tinyChunks);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      rowNumber: 1,
      eventName: 'order.paid',
      rawRecipient: '{"email":"alice@example.com"}',
      rawPayload: '{"orderId":"ord_1","note":"Line 1\nLine 2, with comma"}',
      idempotencyKey: 'idem-1',
      deliverAt: '2026-12-01T10:00:00.000Z',
    });
    expect(rows[1]).toEqual({
      rowNumber: 2,
      eventName: 'user.signup',
      rawRecipient: '',
      rawPayload: '{"plan":"PRO","greeting":"Привіт 🚀"}',
      idempotencyKey: '',
      deliverAt: '',
    });
  });

  it('supports the "event" header alias and records column-count mismatches per row', async () => {
    const csv = [
      'event,payload',
      'invoice.sent,"{""id"":1}"',
      'broken.row,"{""id"":2}",extra_col',
    ].join('\n');

    const rows = await parseChunks([csv]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.eventName).toBe('invoice.sent');
    expect(rows[0]?.columnCountError).toBeUndefined();
    expect(rows[1]?.rowNumber).toBe(2);
    expect(rows[1]?.columnCountError).toContain('Expected 2 CSV columns, received 3');
  });

  it('rejects missing required headers, unknown columns, or empty files with CsvHeaderValidationError', async () => {
    await expect(parseChunks([''])).rejects.toBeInstanceOf(CsvHeaderValidationError);
    await expect(parseChunks(['event_name,recipient\norder.paid,{}\n'])).rejects.toBeInstanceOf(
      CsvHeaderValidationError,
    );
    await expect(
      parseChunks(['event_name,payload,unknown_col\norder.paid,{},1\n']),
    ).rejects.toBeInstanceOf(CsvHeaderValidationError);
    await expect(
      parseChunks(['event_name,event,payload\norder.paid,order.paid,{}\n']),
    ).rejects.toBeInstanceOf(CsvHeaderValidationError);
  });

  it('rejects malformed unclosed quotes with CsvParseError', async () => {
    const malformed = 'event_name,payload\norder.paid,"{""unclosed"":true}';
    await expect(parseChunks([malformed])).rejects.toBeInstanceOf(CsvParseError);
  });

  it('enforces maxRows safety ceiling with CsvRowLimitExceededError', async () => {
    const csv = [
      'event_name,payload',
      'evt.1,"{}"',
      'evt.2,"{}"',
      'evt.3,"{}"',
    ].join('\n');

    await expect(parseChunks([csv], 2)).rejects.toBeInstanceOf(CsvRowLimitExceededError);
  });

  it('propagates backpressure cleanly when downstream consumer processes slowly', async () => {
    const lines = ['event_name,payload'];
    for (let i = 1; i <= 40; i += 1) {
      lines.push(`evt.${i},"{""index"":${i}}"`);
    }

    const parser = new CsvParserStream({ highWaterMark: 4 });
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    const processed: number[] = [];

    const slowSink = new Writable({
      objectMode: true,
      highWaterMark: 2,
      write(record: CsvRowRecord, _encoding, callback) {
        activeWrites += 1;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
        setTimeout(() => {
          processed.push(record.rowNumber);
          activeWrites -= 1;
          callback();
        }, 1);
      },
    });

    await pipeline(Readable.from([lines.join('\n')]), parser, slowSink);

    expect(processed).toHaveLength(40);
    expect(maxConcurrentWrites).toBe(1);
  });
});
