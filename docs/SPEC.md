# KestrelMQ: Architectural Specification and Development Plan

## 1. System Overview & Product Value

**Purpose:** A self-hosted, multi-tenant notification orchestration and guaranteed webhook delivery platform (a functional alternative to Novu + HookPulse + Svix).

### Key Problems Solved
- **Primary Backend Offloading:** Relieves main application services and serverless functions (Next.js, Vercel, Cloudflare Workers) from background execution, network latency, and retry management.
- **Unified Notification Gateway:** Single integration point for multi-channel delivery (Email via Mailgun/Resend/SMTP, Telegram Bot API, Outbound Webhooks).
- **Delayed Execution:** Supports scheduled message delivery and deferred webhook execution via the `deliverAt` parameter.
- **Secure Credential Storage:** Cryptographic protection and rotation of client integration credentials using `AES-256-GCM`.
- **Guaranteed Delivery (At-least-once):** Built-in exponential backoff retries, Dead Letter Queue (DLQ) handling, and manual task re-execution (`Replay`).
- **Inbound Webhook Gateway & Buffering:** Protects client backends from traffic spikes when receiving webhooks from external platforms (Stripe, Shopify, Monobank, GitHub) with incoming HMAC signature verification, rate-limited delivery shaping, and a `Pause / Resume` toggle during deployments or database migrations without losing events.

---

## 2. Technology Stack

- **Language & Runtime:** TypeScript 6.0 (strict mode, full ESM support), Node.js 26 LTS ('Lithium', v26.13+).
- **Framework:** NestJS 12 (v12.6+, modular architecture, Dependency Injection, Guards, Interceptors, Pipes, Exception Filters).
- **Database & ORM:** PostgreSQL 18 + Prisma ORM 7 (ACID transactions, JSONB support, composite and partial indexes).
- **Queues & Caching:** Redis 8.2 Extended + BullMQ 6 (v6.4+; delayed jobs, worker-level rate limiting, exponential backoff, DLQ).
- **Validation & Documentation:** `class-validator`, `class-transformer`, `Zod` (strict runtime environment validation on startup), Swagger / OpenAPI (`@nestjs/swagger`).
- **AI Agent Integration (MCP):** `@nestjs/mcp` + `@modelcontextprotocol/sdk` (Streamable HTTP Model Context Protocol server for AI coding agents and operational assistants).
- **Security:** Node.js `crypto` (`AES-256-GCM` for credential encryption, `HMAC-SHA256` for outbound webhook signatures, `SHA-256` for workspace API key hashing), `Argon2` for user password hashing.
- **Testing & Infrastructure:** Vitest 5 (v5.1+), Testcontainers (ephemeral real Postgres and Redis containers in E2E tests), Docker (multi-stage build), Docker Compose.
- **Compatibility Note:** `package.json` and `tsconfig.json` must explicitly enforce a consistent module resolution strategy (ESM `"type": "module"` with `moduleResolution: "nodenext"`) for seamless compatibility with NestJS 12, Prisma 7, and BullMQ 6.

---

## 3. System Architecture & Data Flows

### 3.1. Process Separation (API vs. Workers)
- **API Service (`src/main.ts`):** Handles incoming REST requests, authentication, rate limiting, and idempotency checks; persists events transactionally in PostgreSQL; enqueues jobs into BullMQ; and immediately responds with `202 Accepted`. Never makes direct outbound HTTP calls to external providers.
- **Worker Service (`src/worker.ts`):** An isolated process (or standalone container) that consumes jobs from Redis/BullMQ queues, decrypts integration credentials in memory, invokes provider adapters, and records every delivery attempt in PostgreSQL.

### 3.2. Inbound Event Lifecycle (Ingestion & Fan-out Flow)
1. Client sends `POST /v1/events` with headers `Authorization: Bearer kmq_live_...` and `Idempotency-Key: <unique_key>`, along with body (`event`, `recipient`, `payload`, `deliverAt`).
2. `AuthGuard` validates the API key by hashing the incoming token (`SHA-256`) and looking up the active key in Redis/PostgreSQL to extract `workspaceId`.
3. `SchemaValidationGuard` validates `payload` against the stored schema in `event_schemas` (if configured for `workspaceId + event_name`):
   - **DISABLED (default):** Accepts `payload` without validation.
   - **WARN:** Enqueues the event even on schema mismatch, but records validation warnings in `schema_warnings` for UI highlighting.
   - **STRICT:** Immediately rejects invalid payloads with `400 Bad Request` and detailed Ajv validation errors.
4. `RateLimitGuard` enforces workspace request quotas using a Redis Sliding Window algorithm. Exceeding limits returns `429 Too Many Requests` with a `Retry-After` header.
5. `IdempotencyInterceptor` checks `idempotency:{workspaceId}:{key}` in Redis (`SET NX EX 86400`). If the key already exists, returns the cached `202 Accepted` response without duplicate enqueueing.
6. Persists the record into `events` within a single PostgreSQL transaction.
7. Queries all active `routing_rules` matching `workspaceId` and `event_name` (e.g., `order.paid` or wildcard `*`).
8. For each matching rule, creates a `deliveries` record (`PENDING` or `SCHEDULED`) and enqueues a job in BullMQ (with `delay` if `deliverAt` is set). If `recipient` is omitted in the event envelope, target fields (`email`, `telegramChatId`, `webhookUrl`) are resolved dynamically from nested `payload` properties via `getByPath`.
9. API responds with `202 Accepted`, returning `eventId` and created `deliveryIds`.

### 3.3. Delivery Lifecycle & Failure Handling (Delivery & Retry Flow)
1. Worker dequeues a `deliveryId` job from BullMQ.
2. Fetches `delivery`, its parent `event`, and associated `integration`.
3. Decrypts provider credentials (e.g., Mailgun `apiKey` and `domain`) in memory using `ENCRYPTION_MASTER_KEY`.
4. Selects the appropriate adapter via `ProviderFactory` (Strategy pattern).
5. **Content Resolution Priority:**
   - **When `template_id` is present on `routing_rule`:** Compiles `subject_template` and `body_template` via `TemplatesService` (Handlebars) using variables from `event.payload`.
   - **When `template_id` is `null` (BYOT — Bring Your Own Template mode, e.g., client-rendered React Email or MJML):** Reads pre-rendered fields directly from `event.payload` (`payload.subject`, `payload.html`, `payload.text` for Email; `payload.text` or serialized JSON for Telegram/Webhook). If neither a template nor raw content (`html` / `text`) is provided for Email/Telegram channels, the delivery fails immediately with a fatal validation error.
6. Executes the external provider request with a strict timeout (default 10s).
7. Appends a detailed audit record to `delivery_attempts` (attempt number, HTTP status, response body or error message, duration in ms).
8. **Outcome Handling:**
   - **Success (HTTP 2xx):** Updates `deliveries.status` to `DELIVERED`.
   - **Transient Failure (HTTP 429, 5xx, network timeout):** Throws an error to trigger BullMQ exponential backoff retries (`10s -> 1m -> 5m -> 30m -> 2h`, max 5 attempts) with jitter. Keeps status as `RETRYING`.
   - **Fatal Client Error (HTTP 400, 401, 403, 404):** Retries are futile; immediately marks delivery as `FAILED`.
   - **Max Attempts Exhausted:** Moves job to Dead Letter Queue (DLQ) and sets status to `FAILED`.

### 3.4. Outbound Webhook Security (HMAC Signature)
When dispatching outbound webhooks to a client URL, the worker attaches:
- `X-KestrelMQ-Timestamp`: Current Unix timestamp (in seconds).
- `X-KestrelMQ-Signature`: `v1=` + HMAC-SHA256 hex digest.

Signature formula:
`HMAC-SHA256("{timestamp}.{rawJsonBody}", workspace_signing_secret)`

Receiving servers can verify authenticity and prevent replay attacks by rejecting timestamps older than 5 minutes.

### 3.5. Inbound Webhook Flow (Inbound Ingestion & Buffering Flow)
1. External provider (Stripe / Shopify / Monobank / Custom) sends `POST /v1/inbound/:sourceSlug`.
2. `InboundController` captures the raw request buffer (`rawBody` for exact cryptographic verification), looks up `inbound_sources` by `sourceSlug`, decrypts the source secret via `CryptoService`, and verifies the incoming provider signature (Stripe `t=...,v1=...`, Shopify `X-Shopify-Hmac-Sha256`, GitHub `X-Hub-Signature-256`, or `Custom HMAC`).
3. Transactionally creates an `events` record (`direction: INBOUND`, `inbound_source_id`) and a `deliveries` task targeting `inbound_sources.target_url`.
4. If `is_paused = true` on the source, the delivery is stored with status `PAUSED` until `POST /v1/inbound-sources/:id/resume` is invoked, after which workers drain buffered deliveries smoothly according to `max_rate_per_sec` (BullMQ rate limiter).
5. API immediately responds `200 OK` to the upstream provider.

---

## 4. Database Design (PostgreSQL)

### Tables & Data Types (12 Models)

1. **`users`** — System user accounts.
   - `id` (UUID, PK)
   - `email` (VARCHAR, UNIQUE)
   - `password_hash` (VARCHAR — Argon2)
   - `full_name` (VARCHAR)
   - `created_at` (TIMESTAMP), `updated_at` (TIMESTAMP)

2. **`workspaces`** — Isolated multi-tenant workspaces.
   - `id` (UUID, PK)
   - `name` (VARCHAR)
   - `slug` (VARCHAR, UNIQUE)
   - `plan` (ENUM: `FREE`, `PRO`, `ENTERPRISE`)
   - `webhook_signing_secret` (VARCHAR)
   - `created_at` (TIMESTAMP), `updated_at` (TIMESTAMP)

3. **`workspace_members`** — User-to-workspace membership & RBAC.
   - `id` (UUID, PK)
   - `workspace_id` (FK -> `workspaces.id`, ON DELETE CASCADE)
   - `user_id` (FK -> `users.id`, ON DELETE CASCADE)
   - `role` (ENUM: `OWNER`, `ADMIN`, `VIEWER`)
   - `created_at` (TIMESTAMP)
   - *Unique Index:* `(workspace_id, user_id)`

4. **`api_keys`** — Ingestion API authentication keys.
   - `id` (UUID, PK)
   - `workspace_id` (FK -> `workspaces.id`, ON DELETE CASCADE)
   - `name` (VARCHAR)
   - `key_hash` (VARCHAR, UNIQUE — SHA-256)
   - `last_used_at` (TIMESTAMP, NULLABLE)
   - `revoked_at` (TIMESTAMP, NULLABLE)
   - `created_at` (TIMESTAMP)

5. **`integrations`** — External provider configurations.
   - `id` (UUID, PK)
   - `workspace_id` (FK -> `workspaces.id`, ON DELETE CASCADE)
   - `name` (VARCHAR)
   - `channel` (ENUM: `EMAIL`, `TELEGRAM`, `WEBHOOK`, `SLACK`)
   - `provider` (ENUM: `MAILGUN`, `RESEND`, `SMTP`, `TELEGRAM_BOT`, `CUSTOM_WEBHOOK`)
   - `encrypted_credentials` (TEXT)
   - `iv` (VARCHAR)
   - `auth_tag` (VARCHAR)
   - `is_active` (BOOLEAN, DEFAULT true)
   - `created_at` (TIMESTAMP), `updated_at` (TIMESTAMP)

6. **`templates`** — Message templates.
   - `id` (UUID, PK)
   - `workspace_id` (FK -> `workspaces.id`, ON DELETE CASCADE)
   - `name` (VARCHAR)
   - `subject_template` (VARCHAR, NULLABLE)
   - `body_template` (TEXT)
   - `created_at` (TIMESTAMP), `updated_at` (TIMESTAMP)

7. **`routing_rules`** — Event-to-channel routing rules.
   - `id` (UUID, PK)
   - `workspace_id` (FK -> `workspaces.id`, ON DELETE CASCADE)
   - `event_name` (VARCHAR — e.g., `order.paid` or `*`)
   - `integration_id` (FK -> `integrations.id`, ON DELETE CASCADE)
   - `template_id` (FK -> `templates.id`, NULLABLE, ON DELETE SET NULL)
   - `target_override` (VARCHAR, NULLABLE)
   - `is_active` (BOOLEAN, DEFAULT true)
   - `created_at` (TIMESTAMP)
   - *Composite Index:* `(workspace_id, event_name, is_active)`

8. **`events`** — Ingested events log.
   - `id` (UUID, PK)
   - `workspace_id` (FK -> `workspaces.id`, ON DELETE CASCADE)
   - `idempotency_key` (VARCHAR, NULLABLE)
   - `event_name` (VARCHAR)
   - `recipient` (JSONB)
   - `payload` (JSONB)
   - `scheduled_for` (TIMESTAMP, NULLABLE)
   - `schema_warnings` (JSONB, NULLABLE)
   - `direction` (ENUM: `OUTBOUND`, `INBOUND`, DEFAULT `OUTBOUND`)
   - `inbound_source_id` (FK -> `inbound_sources.id`, NULLABLE, ON DELETE SET NULL)
   - `created_at` (TIMESTAMP)
   - *Partial Unique Index:* `(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL`

9. **`deliveries`** — Individual delivery tasks.
   - `id` (UUID, PK)
   - `workspace_id` (FK -> `workspaces.id`, ON DELETE CASCADE)
   - `event_id` (FK -> `events.id`, ON DELETE CASCADE)
   - `routing_rule_id` (FK -> `routing_rules.id`, NULLABLE)
   - `integration_id` (FK -> `integrations.id`, NULLABLE)
   - `status` (ENUM: `PENDING`, `SCHEDULED`, `RETRYING`, `DELIVERED`, `FAILED`, `CANCELED`, `PAUSED`)
   - `attempt_count` (INT, DEFAULT 0)
   - `max_attempts` (INT, DEFAULT 5)
   - `next_retry_at` (TIMESTAMP, NULLABLE)
   - `delivered_at` (TIMESTAMP, NULLABLE)
   - `created_at` (TIMESTAMP), `updated_at` (TIMESTAMP)
   - *Composite Index:* `(workspace_id, status, created_at DESC)`

10. **`delivery_attempts`** — Execution attempt audit logs.
    - `id` (UUID, PK)
    - `delivery_id` (FK -> `deliveries.id`, ON DELETE CASCADE)
    - `attempt_number` (INT)
    - `request_payload` (JSONB)
    - `response_status` (INT, NULLABLE)
    - `response_body` (TEXT, NULLABLE)
    - `error_message` (TEXT, NULLABLE)
    - `duration_ms` (INT)
    - `created_at` (TIMESTAMP)
    - *Composite Index:* `(delivery_id, attempt_number)`

11. **`event_schemas`** — Custom event schemas for validation and autocomplete.
    - `id` (UUID, PK)
    - `workspace_id` (FK -> `workspaces.id`, ON DELETE CASCADE)
    - `event_name` (VARCHAR)
    - `sample_payload` (JSONB)
    - `json_schema` (JSONB)
    - `validation_mode` (ENUM: `DISABLED`, `WARN`, `STRICT`, DEFAULT `DISABLED`)
    - `created_at` (TIMESTAMP), `updated_at` (TIMESTAMP)
    - *Unique Index:* `(workspace_id, event_name)`

12. **`inbound_sources`** — Inbound webhook gateway endpoints.
    - `id` (UUID, PK)
    - `workspace_id` (FK -> `workspaces.id`, ON DELETE CASCADE)
    - `name` (VARCHAR)
    - `source_slug` (VARCHAR, UNIQUE)
    - `provider_type` (ENUM: `STRIPE`, `SHOPIFY`, `GITHUB`, `CUSTOM_HMAC`, `NONE`)
    - `encrypted_signing_secret` (TEXT, NULLABLE)
    - `iv` (VARCHAR, NULLABLE), `auth_tag` (VARCHAR, NULLABLE)
    - `target_url` (VARCHAR)
    - `max_rate_per_sec` (INT, DEFAULT 10)
    - `is_paused` (BOOLEAN, DEFAULT false)
    - `created_at` (TIMESTAMP), `updated_at` (TIMESTAMP)

---

## 5. NestJS Module Architecture & Project Structure

- `src/config/`: Environment variable loading and validation via Zod.
- `src/common/`: Guards (`JwtAuthGuard`, `ApiKeyGuard`, `RolesGuard`, `RateLimitGuard`), Interceptors (`IdempotencyInterceptor`, `LoggingInterceptor`), `HttpExceptionFilter` (RFC 9457 / RFC 7807), `CryptoService`, and `getByPath` helper.
- `src/modules/auth/`: User registration, login, JWT Access (15m) and Refresh (7d) tokens, Redis refresh token rotation.
- `src/modules/workspaces/`: Workspace management, RBAC member assignments, and API key generation.
- `src/modules/integrations/`: Provider connections, `AES-256-GCM` secret encryption, `POST /v1/integrations/:id/test`.
- `src/modules/providers/`: Strategy pattern (`NotificationProvider`, `ProviderFactory`, adapters for Mailgun, Resend, Telegram, and Webhook).
- `src/modules/templates/`: Handlebars template compilation engine + fallback resolution for pre-rendered `payload.html` / `payload.text` (BYOT).
- `src/modules/rules/`: Routing rules mapping `event_name -> integration + template`.
- `src/modules/schemas/`: Sample-to-Schema JSON Schema inference, Ajv validation, and dot-path variable extraction.
- `src/modules/inbound/`: Public inbound webhook receiver (`rawBody`), upstream HMAC signature verification, `inbound_sources` CRUD, and `Pause / Resume` queue draining.
- `src/modules/events/`: Single event ingestion (`POST /v1/events`), fan-out orchestration, and streaming CSV bulk import (`POST /v1/events/bulk`).
- `src/modules/deliveries/`: Cursor-based delivery logs, attempt inspection, `Replay`, and `Cancel`.
- `src/modules/analytics/`: Aggregated delivery metrics with Redis Cache-Aside caching (60s TTL).
- `src/modules/mcp/`: Official Model Context Protocol (MCP) server (`@nestjs/mcp` + `@modelcontextprotocol/sdk`) exposing workspace-isolated tools and resources over Streamable HTTP.
- `src/workers/`: BullMQ background processors (`DeliveryProcessor`, `RetentionProcessor`, `src/worker.ts`) with Graceful Shutdown hooks.
- `packages/sdk/`: Strongly typed TypeScript client SDK (`@kestrelmq/sdk`).

---

## 6. REST API Specification

| Method | Path | Auth | Description | Status Codes |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/v1/auth/register` | Public | Register a new user | `201, 400, 409` |
| `POST` | `/v1/auth/login` | Public | Authenticate user and issue token pair | `200, 401` |
| `POST` | `/v1/auth/refresh` | Refresh JWT | Rotate Refresh token and issue new Access token | `200, 401` |
| `POST` | `/v1/auth/logout` | Access JWT | Revoke current Refresh token | `204, 401` |
| `POST` | `/v1/workspaces` | Access JWT | Create a new workspace | `201, 400, 401` |
| `POST` | `/v1/workspaces/:id/members` | Access JWT (Admin) | Add member to workspace | `201, 403, 404` |
| `POST` | `/v1/workspaces/:id/api-keys` | Access JWT (Admin) | Generate new API key `kmq_live_...` | `201, 403` |
| `POST` | `/v1/integrations` | Access JWT (Admin) | Create provider integration | `201, 400` |
| `GET` | `/v1/integrations` | Access JWT | List workspace integrations | `200` |
| `POST` | `/v1/integrations/:id/test` | Access JWT (Admin) | Send test connectivity ping | `200, 400, 502` |
| `DELETE` | `/v1/integrations/:id` | Access JWT (Admin) | Delete integration | `204, 404` |
| `POST` | `/v1/templates` | Access JWT | Create message template | `201, 400` |
| `GET` | `/v1/templates` | Access JWT | List message templates | `200` |
| `POST` | `/v1/rules` | Access JWT | Create routing rule | `201, 400` |
| `GET` | `/v1/rules` | Access JWT | List routing rules | `200` |
| `PATCH` | `/v1/rules/:id` | Access JWT | Update routing rule | `200, 404` |
| `POST` | `/v1/events` | API Key | Ingest single event (Idempotency, `deliverAt`) | `202, 400, 401, 429` |
| `POST` | `/v1/events/bulk` | API Key | Stream CSV bulk ingestion (`multipart/form-data`) | `202, 400, 413` |
| `GET` | `/v1/deliveries` | Access JWT | List deliveries (cursor pagination) | `200` |
| `GET` | `/v1/deliveries/:id` | Access JWT | Get delivery details and attempt history | `200, 404` |
| `POST` | `/v1/deliveries/:id/replay` | Access JWT | Re-enqueue delivery for execution | `200, 404` |
| `POST` | `/v1/deliveries/:id/cancel` | Access JWT | Cancel scheduled/pending delivery | `200, 400, 404` |
| `GET` | `/v1/analytics/summary` | Access JWT | Delivery metrics summary (`24h`, `7d`, `30d`) | `200` |
| `POST` | `/v1/inbound-sources` | Access JWT | Create inbound webhook source | `201, 400` |
| `GET` | `/v1/inbound-sources` | Access JWT | List inbound webhook sources | `200` |
| `POST` | `/v1/inbound-sources/:id/pause` | Access JWT | Pause forwarding (deployment buffer mode) | `200, 404` |
| `POST` | `/v1/inbound-sources/:id/resume` | Access JWT | Resume forwarding buffered webhooks | `200, 404` |
| `POST` | `/v1/inbound/:sourceSlug` | Public (HMAC) | Public inbound webhook receiver | `200, 401, 404` |
| `POST / GET / DELETE` | `/mcp` | API Key | Model Context Protocol (MCP) Streamable HTTP endpoint | `200, 202, 400, 401` |

---

## 7. Model Context Protocol (MCP) Server

### 7.1. Packages & Streamable HTTP Transport
- **Stack:** Built with the official `@nestjs/mcp` module paired with `@modelcontextprotocol/sdk`.
- **Process Boundary:** Mounted exclusively inside the HTTP API Gateway (`AppModule` via `src/main.ts`) over Streamable HTTP (`POST`, `GET`, and `DELETE /mcp`) using stateless or workspace-scoped sessions. Never mounted in `WorkerModule` (`src/worker.ts`), preserving strict API/Worker process decoupling and ensuring MCP tool invocations enqueue background jobs rather than making direct external provider HTTP calls.

### 7.2. Authentication & Multi-Tenant Isolation
- **Guard:** Protected by `ApiKeyGuard` (`Authorization: Bearer kmq_live_...` or `X-API-Key`).
- **Workspace Resolution:** Incoming API keys are hashed with `SHA-256` and resolved via Redis/PostgreSQL to attach `workspaceId` to the request context. Every MCP `@Tool` execution and `@Resource` read derives its tenant scope strictly from this verified `workspaceId` (never from client-supplied arguments).

### 7.3. MCP Tools (`@Tool`)
1. **`send_event`** — Enqueues an outbound notification event via `IngestionService.ingestEvent` (accepting `event`, `payload`, optional `recipient`, `idempotencyKey`, and `deliverAt`), returning `eventId` and created `deliveryIds`.
2. **`list_deliveries`** — Queries recent workspace deliveries via `DeliveriesService.listDeliveries` using high-performance keyset cursor pagination with optional `limit`, `cursor`, `status`, `eventName`, and `integrationId` filters.
3. **`inspect_delivery`** — Fetches full delivery details alongside the ordered `delivery_attempts` audit timeline (with sensitive keys recursively masked via `maskSensitiveData`) via `DeliveriesService.getDeliveryById`.
4. **`replay_delivery`** — Resets a delivery to `PENDING` (`nextRetryAt: null`) and re-enqueues a fresh BullMQ job via `DeliveriesService.replayDelivery` (`POST /v1/deliveries/:id/replay` semantics).
5. **`get_analytics_summary`** — Returns workspace delivery metrics (`24h` | `7d` | `30d` window: total events, status counts, success rate %, and avg/p95 `durationMs`) via `AnalyticsService.getSummary` backed by 60s Redis Cache-Aside.
6. **`toggle_inbound_source`** — Pauses (`pause`) or resumes (`resume`, draining buffered `PAUSED` deliveries smoothly at `max_rate_per_sec`) an inbound webhook source via `InboundService`.

### 7.4. MCP Resources (`@Resource`)
1. **`kestrelmq://schemas`** — Exposes registered workspace event names, validation modes (`DISABLED`, `WARN`, `STRICT`), extracted dot-path variables, and JSON Schemas via `EventSchemasService.listSchemas` so AI agents can inspect payload contracts before invoking `send_event`.
2. **`kestrelmq://templates`** — Exposes available workspace notification templates and associated routing channels via `TemplatesService` so AI agents can discover template structure and variable placeholders.

---

## 8. Demo Playground (Web UI) & Deployment Strategy

### 8.1. Web UI Playground Screens (`apps/web`, Next.js 16)
1. **Provider Connections:** Form to add Mailgun, Telegram Bot Token, or Webhook URL with a `Test Connection` button.
2. **Routing Rules & Schemas:** Bind events to integrations and templates, run `Infer Schema from Sample`, select validation modes (`DISABLED`, `WARN`, `STRICT`), and use `{{...}}` variable autocomplete.
3. **Live Event Playground:** Interactive form to dispatch events with `deliverAt` delay, `Idempotency-Key` generation, and a "Simulate 500 Failure" toggle to demonstrate retries.
4. **Live Delivery Logs:** Delivery table with statuses (`PENDING`, `RETRYING`, `DELIVERED`, `FAILED`, `PAUSED`), expandable `delivery_attempts` audit logs, and a manual `Replay` action.
5. **Inbound Webhook Buffer (Deployment Simulation):** `Pause Endpoint` button, burst dispatch of simulated Stripe webhooks, and `Resume` to observe rate-limited queue draining.

### 8.2. Deployment Strategy
- **Docker Compose (VPS):** `api`, `worker`, `postgres:18-alpine`, `redis:8.2-alpine`, `web` behind Caddy/Nginx with automatic HTTPS (Let's Encrypt).
- **Public Demo Access:** Pre-seeded demo workspace (one-click login via startup seed script), Swagger UI (`/docs`), and a built-in mock webhook receiver.
