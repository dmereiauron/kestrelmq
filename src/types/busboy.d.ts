declare module 'busboy' {
  import type { IncomingHttpHeaders } from 'node:http';
  import type { Readable, Writable } from 'node:stream';

  export interface BusboyLimits {
    fieldNameSize?: number;
    fieldSize?: number;
    fields?: number;
    fileSize?: number;
    files?: number;
    parts?: number;
    headerPairs?: number;
  }

  export interface BusboyConfig {
    headers: IncomingHttpHeaders;
    highWaterMark?: number;
    fileHwm?: number;
    defCharset?: string;
    defParamCharset?: string;
    preservePath?: boolean;
    limits?: BusboyLimits;
  }

  export interface FileInfo {
    filename: string;
    encoding: string;
    mimeType: string;
  }

  export interface FieldInfo {
    nameTruncated: boolean;
    valueTruncated: boolean;
    encoding: string;
    mimeType: string;
  }

  export interface BusboyFileStream extends Readable {
    truncated?: boolean;
  }

  export interface Busboy extends Writable {
    addListener(
      event: 'file',
      listener: (name: string, stream: BusboyFileStream, info: FileInfo) => void,
    ): this;
    addListener(
      event: 'field',
      listener: (name: string, value: string, info: FieldInfo) => void,
    ): this;
    addListener(event: 'partsLimit', listener: () => void): this;
    addListener(event: 'filesLimit', listener: () => void): this;
    addListener(event: 'fieldsLimit', listener: () => void): this;
    addListener(event: 'error', listener: (error: unknown) => void): this;
    addListener(event: 'close', listener: () => void): this;
    addListener(event: 'finish', listener: () => void): this;
    addListener(event: string | symbol, listener: (...args: unknown[]) => void): this;

    on(
      event: 'file',
      listener: (name: string, stream: BusboyFileStream, info: FileInfo) => void,
    ): this;
    on(
      event: 'field',
      listener: (name: string, value: string, info: FieldInfo) => void,
    ): this;
    on(event: 'partsLimit', listener: () => void): this;
    on(event: 'filesLimit', listener: () => void): this;
    on(event: 'fieldsLimit', listener: () => void): this;
    on(event: 'error', listener: (error: unknown) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'finish', listener: () => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;

    once(
      event: 'file',
      listener: (name: string, stream: BusboyFileStream, info: FileInfo) => void,
    ): this;
    once(
      event: 'field',
      listener: (name: string, value: string, info: FieldInfo) => void,
    ): this;
    once(event: 'partsLimit', listener: () => void): this;
    once(event: 'filesLimit', listener: () => void): this;
    once(event: 'fieldsLimit', listener: () => void): this;
    once(event: 'error', listener: (error: unknown) => void): this;
    once(event: 'close', listener: () => void): this;
    once(event: 'finish', listener: () => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  function busboy(config: BusboyConfig): Busboy;
  export = busboy;
}
