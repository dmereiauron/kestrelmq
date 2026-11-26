# KestrelMQ Execution & Memory Progress Tracker

## Global Architecture Checklist

### Stage 1: Infrastructure, Database Schema & Cryptography
- [ ] Node.js / NestJS project initialization with TypeScript strict mode & nodenext resolution
- [ ] Environment validation using Zod (`env.validation.ts` validating POSTGRES_URL, REDIS_URL, APP_SECRET, PORT)
- [ ] Docker Compose setup (PostgreSQL 18 alpine, Redis 8.2 alpine with healthchecks and volumes)
- [ ] Prisma schema initialization (`schema.prisma` matching SPEC.md Section 4 with composite/partial indexes)
- [ ] `CryptoService` implementation (AES-256-GCM AEAD encryption/decryption, HMAC-SHA256 signatures with timestamp)
- [ ] `CryptoService` Unit Tests with 100% code coverage in Vitest

### Stage 2: Request Lifecycle, Auth, RBAC & API Keys
- [ ] Custom Request Lifecycle setup (Middleware -> Guards -> Interceptors -> Pipes -> Filters)
- [ ] Workspace & User models integration in Auth flow
- [ ] JWT Authentication & Refresh Token rotation mechanism in Redis (with reuse detection)
- [ ] `ApiKeyGuard` with Redis caching layer (SHA-256 hash lookup, 300s TTL)
- [ ] `@Roles()` decorator & `RolesGuard` implementation for workspace-level permissions
- [ ] Global `HttpExceptionFilter` adhering to RFC 9457 / RFC 7807 (Problem Details)
- [ ] Global `LoggingInterceptor` with recursive key masking and WeakSet cycle protection

### Stage 3: Strategy Pattern, Provider Adapters & Templating
- [ ] Dynamic `ProviderFactory` setup using NestJS custom dynamic providers
- [ ] Abstract `NotificationProvider` interface definition
- [ ] `WebhookAdapter` implementation (Outbound HTTP POST, AbortSignal timeout 5000ms, HMAC-SHA256 headers)
- [ ] `TelegramAdapter` implementation (Telegram Bot API integration with HTML parsing mode)
- [ ] `MailgunAdapter` implementation (Mailgun REST API integration)
- [ ] Handlebars template compilation engine (`TemplatesService` with disabled prototype access)
- [ ] Rules evaluation engine (`RulesService` with JsonLogic matching)
- [ ] `POST /v1/integrations/:id/test` connectivity ping endpoint
- [ ] `EventSchemasModule`: Sample-to-Schema inference & Ajv runtime validation (DISABLED / WARN / STRICT modes)
- [ ] Safe nested dot-path resolver utility (`getByPath`) with prototype pollution prevention (`__proto__`, `constructor` checks)

### Stage 4: Ingestion, Idempotency, BullMQ Queues & Workers
- [ ] `POST /v1/events` single event ingestion endpoint
- [ ] Enable `rawBody: true` in NestJS application setup (`src/main.ts`)
- [ ] `InboundModule`: CRUD for `inbound_sources`, public endpoint `POST /v1/inbound/:sourceSlug` with HMAC verification using `req.rawBody`
- [ ] Inbound Pause/Resume endpoints (`POST /v1/inbound-sources/:id/pause` & `/resume`) with BullMQ rate-limited delivery
- [ ] Support `PAUSED` delivery status in `DeliveryProcessor` worker and database schema
- [ ] `IdempotencyInterceptor` using Redis `SET key PROCESSING NX EX 86400` pattern
- [ ] Standalone Worker process entry point (`src/worker.ts`)
- [ ] BullMQ Producers and Queue configuration (`events-queue`, `deliveries-queue`)
- [ ] `DeliveryProcessor` worker with error classification (Fatal 4xx vs Retryable 429/5xx/Network) & exponential backoff with jitter
- [ ] Audit trail recording into `delivery_attempts` database table
- [ ] Graceful shutdown hooks (`SIGTERM` / `SIGINT`) in Worker process to complete active jobs

### Stage 5: Streams, Cursor Pagination, Rate Limiting & Analytics
- [ ] `POST /v1/events/bulk` endpoint with Node.js Stream parsing (`stream.pipeline`, `Transform`, backpressure handling)
- [ ] High-performance Cursor-based (Keyset) Pagination for `DeliveriesService`
- [ ] Replay and Cancellation endpoints (`POST /v1/deliveries/:id/replay`, `POST /v1/deliveries/:id/cancel`)
- [ ] Redis Sliding Window Rate Limiting Guard backed by Redis ZSET
- [ ] `AnalyticsService` with Cache-Aside aggregation pattern and 60s TTL

### Stage 6: E2E Testing, Typed SDK, OpenAPI & Production Docker
- [ ] E2E integration tests using Testcontainers (dynamic Postgres 18 + Redis 8.2 containers)
- [ ] Simulation tests for Exponential Backoff retries on simulated 500 failures
- [ ] `@kestrelmq/sdk` strongly typed TypeScript client wrapper in `sdk/` directory
- [ ] Complete OpenAPI / Swagger setup (`/docs` route with `x-api-key` security scheme)
- [ ] Production Multi-stage `Dockerfile` (Node 26 Alpine, non-root `USER node`, separate API/Worker entrypoints)
- [ ] Final `README.md` update

---

## Architecture Decision Log (ADL)
| Decision ID | Title | Summary & Rationale | Status |
|---|---|---|---|
| ADL-001 | Separate API and Worker processes | Decoupled HTTP API from queue execution to allow independent scaling and prevent Worker failures from crashing API gateway. | Approved |
| ADL-002 | Keyset Pagination for Deliveries | Avoided `OFFSET` in SQL queries to maintain O(1) performance on millions of delivery records. | Approved |
| ADL-003 | RFC 9457 Problem Details | Standardized error API output format across all services. | Approved |

---

## Context Memory Buffer
This section is updated by the AI Agent after every successful execution session.

- **Last Session Date:** N/A
- **Active Stage:** Stage 1
- **Completed Milestones:** Project setup initiated.
- **Key Decisions Made:** Adopted Node.js 26, NestJS 12, Prisma 7, PostgreSQL 18.
- **Known Blockers / Technical Debt:** None.

---

## Agent Instructions for Updating Progress
1. Mark completed checklist items with `[x]` upon verifying green Vitest / typecheck runs.
2. Update `Context Memory Buffer` with date, active stage, decisions, and any tech debt identified.
3. Log significant architectural changes in the `Architecture Decision Log` table.
