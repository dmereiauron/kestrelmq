import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedWebhookRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: string;
  readonly parsedJson: unknown;
  readonly receivedAtMs: number;
}

export interface PlannedSinkResponse {
  readonly statusCode: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

interface WaiterEntry {
  readonly path: string;
  readonly targetCount: number;
  readonly resolve: (requests: readonly CapturedWebhookRequest[]) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class LocalWebhookSink {
  readonly #server: Server;
  readonly #requestsByPath = new Map<string, CapturedWebhookRequest[]>();
  readonly #responseQueues = new Map<string, PlannedSinkResponse[]>();
  readonly #defaultResponses = new Map<string, PlannedSinkResponse>();
  readonly #waiters = new Set<WaiterEntry>();
  #baseUrl = '';

  private constructor() {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        const rawUrl = req.url ?? '/';
        const path = rawUrl.split('?')[0] ?? '/';
        const rawBuffer = Buffer.concat(chunks);
        const rawBody = rawBuffer.toString('utf8');

        let parsedJson: unknown = null;
        if (rawBody.trim().length > 0) {
          try {
            parsedJson = JSON.parse(rawBody);
          } catch {
            parsedJson = null;
          }
        }

        const captured: CapturedWebhookRequest = {
          method: req.method ?? 'POST',
          path,
          headers: req.headers,
          rawBody,
          parsedJson,
          receivedAtMs: Date.now(),
        };

        const existing = this.#requestsByPath.get(path) ?? [];
        existing.push(captured);
        this.#requestsByPath.set(path, existing);

        const queue = this.#responseQueues.get(path);
        const planned =
          queue && queue.length > 0
            ? queue.shift()!
            : (this.#defaultResponses.get(path) ?? {
                statusCode: 200,
                body: JSON.stringify({ ok: true, receivedAt: captured.receivedAtMs }),
              });

        res.statusCode = planned.statusCode;
        res.setHeader('Content-Type', 'application/json');
        if (planned.headers !== undefined) {
          for (const [key, value] of Object.entries(planned.headers)) {
            res.setHeader(key, value);
          }
        }
        res.end(planned.body ?? JSON.stringify({ status: planned.statusCode }));

        this.#notifyWaiters(path);
      });
    });
  }

  static async start(): Promise<LocalWebhookSink> {
    const sink = new LocalWebhookSink();
    await new Promise<void>((resolve, reject) => {
      sink.#server.once('error', reject);
      sink.#server.listen(0, '127.0.0.1', () => {
        const addr = sink.#server.address() as AddressInfo;
        sink.#baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    return sink;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  urlFor(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${this.#baseUrl}${normalized}`;
  }

  enqueueResponses(path: string, responses: readonly PlannedSinkResponse[]): void {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    this.#responseQueues.set(normalized, [...responses]);
  }

  setDefaultResponse(path: string, response: PlannedSinkResponse): void {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    this.#defaultResponses.set(normalized, response);
  }

  getRequests(path: string): readonly CapturedWebhookRequest[] {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return [...(this.#requestsByPath.get(normalized) ?? [])];
  }

  clearRequests(path?: string): void {
    if (path !== undefined) {
      const normalized = path.startsWith('/') ? path : `/${path}`;
      this.#requestsByPath.delete(normalized);
      return;
    }
    this.#requestsByPath.clear();
  }

  waitForRequests(
    path: string,
    targetCount: number,
    timeoutMs = 15_000,
  ): Promise<readonly CapturedWebhookRequest[]> {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const current = this.#requestsByPath.get(normalized) ?? [];
    if (current.length >= targetCount) {
      return Promise.resolve([...current]);
    }

    return new Promise<readonly CapturedWebhookRequest[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(entry);
        const latestCount = (this.#requestsByPath.get(normalized) ?? []).length;
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${targetCount} requests on ${normalized} (received ${latestCount})`,
          ),
        );
      }, timeoutMs);

      const entry: WaiterEntry = {
        path: normalized,
        targetCount,
        resolve,
        reject,
        timer,
      };
      this.#waiters.add(entry);
    });
  }

  async close(): Promise<void> {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Webhook sink closed while waiting for requests'));
    }
    this.#waiters.clear();

    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  #notifyWaiters(path: string): void {
    const current = this.#requestsByPath.get(path) ?? [];
    for (const waiter of this.#waiters) {
      if (waiter.path === path && current.length >= waiter.targetCount) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve([...current]);
      }
    }
  }
}
