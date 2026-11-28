# `@kestrelmq/sdk`

Zero-dependency, strongly typed ESM TypeScript client SDK for [KestrelMQ](https://github.com/dmereiauron/kestrelmq) built on native `fetch` with RFC 9457 (`application/problem+json`) error parsing.

## Installation

```bash
npm install @kestrelmq/sdk
```

> **Local development across sibling repositories:** Before publishing a new version to npm, you can link the SDK directly from a local checkout (e.g., from a neighboring frontend or service repo) via `"@kestrelmq/sdk": "file:../kestrelmq/sdk"` in `package.json` after running `npm --prefix ../kestrelmq/sdk run build`.

## Quickstart

```ts
import {
  KestrelApiError,
  KestrelClient,
  KestrelTimeoutError,
} from '@kestrelmq/sdk';

const kestrel = new KestrelClient({
  baseUrl: process.env.KESTREL_BASE_URL ?? 'http://localhost:3000',
  apiKey: process.env.KESTREL_API_KEY!, // kmq_live_...
  timeoutMs: 10_000,
});

try {
  // Dispatch an idempotent outbound notification event
  const receipt = await kestrel.events.send({
    event: 'order.paid',
    payload: {
      orderId: 'ord_9001',
      amount: 149.99,
      customer: { email: 'ada@example.com' },
    },
    idempotencyKey: 'order-paid-ord_9001',
  });

  console.log('Queued deliveries:', receipt.deliveryIds);

  // Inspect deliveries with cursor pagination & fetch workspace analytics
  const deliveries = await kestrel.deliveries.list({ limit: 20, status: 'FAILED' });
  const summary = await kestrel.analytics.summary('24h');
  console.log({ failedCount: deliveries.data.length, successRate: summary.successRate });
} catch (error) {
  if (error instanceof KestrelApiError) {
    console.error(error.status, error.title, error.detail, error.retryAfterSec);
  } else if (error instanceof KestrelTimeoutError) {
    console.error(error.message);
  }
}
```

## API Surface

- `kestrel.events.send(input)` — `POST /v1/events` (idempotent event ingestion & `deliverAt` scheduling)
- `kestrel.events.sendBulk(csv, options?)` — `POST /v1/events/bulk` (`Blob`, `Buffer`, `Uint8Array`, `string`, or stream)
- `kestrel.deliveries.list(params?)` — `GET /v1/deliveries` (keyset cursor pagination)
- `kestrel.deliveries.get(id)` — `GET /v1/deliveries/:id` (delivery details + attempt audit trail)
- `kestrel.deliveries.replay(id)` — `POST /v1/deliveries/:id/replay`
- `kestrel.deliveries.cancel(id)` — `POST /v1/deliveries/:id/cancel`
- `kestrel.analytics.summary(window?)` — `GET /v1/analytics/summary` (`'24h' | '7d' | '30d'`)

## License

MIT
