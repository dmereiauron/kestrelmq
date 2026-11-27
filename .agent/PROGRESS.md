# KestrelMQ Execution & Memory Progress Tracker

## Global Architecture Checklist

### Stage 1: Infrastructure, Database Schema & Cryptography
- [x] Node.js / NestJS project initialization with TypeScript strict mode & nodenext resolution
- [x] Environment validation using Zod (`env.validation.ts` validating POSTGRES_URL, REDIS_URL, APP_SECRET, PORT)
- [x] Docker Compose setup (PostgreSQL 18 alpine, Redis 8.2 alpine with healthchecks and volumes)
- [x] Prisma schema initialization (`schema.prisma` matching SPEC.md Section 4 with composite/partial indexes)
- [x] `CryptoService` implementation (AES-256-GCM AEAD encryption/decryption, HMAC-SHA256 signatures with timestamp)
- [x] `CryptoService` Unit Tests with 100% code coverage in Vitest

### Stage 2: Request Lifecycle, Auth, RBAC & API Keys
- [x] Custom Request Lifecycle setup (Middleware -> Guards -> Interceptors -> Pipes -> Filters)
- [x] Workspace & User models integration in Auth flow
- [x] JWT Authentication & Refresh Token rotation mechanism in Redis (with reuse detection)
- [x] `ApiKeyGuard` with Redis caching layer (SHA-256 hash lookup, 300s TTL)
- [x] `@Roles()` decorator & `RolesGuard` implementation for workspace-level permissions
- [x] Global `HttpExceptionFilter` adhering to RFC 9457 / RFC 7807 (Problem Details)
- [x] Global `LoggingInterceptor` with recursive key masking and WeakSet cycle protection

### Stage 3: Strategy Pattern, Provider Adapters & Templating
- [x] Dynamic `ProviderFactory` setup using NestJS custom dynamic providers
- [x] Abstract `NotificationProvider` interface definition
- [x] `WebhookAdapter` implementation (Outbound HTTP POST, AbortSignal timeout 10000ms per SPEC.md §3.3, HMAC-SHA256 headers)
- [x] `TelegramAdapter` implementation (Telegram Bot API integration with HTML parsing mode)
- [x] `MailgunAdapter` implementation (Mailgun REST API integration)
- [x] Handlebars template compilation engine (`TemplatesService` with disabled prototype access & BYOT fallback)
- [x] Rules evaluation engine (`RulesService` with wildcard matching, JsonLogic evaluation & dynamic target resolution)
- [x] `POST /v1/integrations/:id/test` connectivity ping endpoint
- [x] `EventSchemasModule`: Sample-to-Schema inference & Ajv runtime validation (DISABLED / WARN / STRICT modes)
- [x] Safe nested dot-path resolver utility (`getByPath`) with prototype pollution prevention (`__proto__`, `constructor` checks)

### Stage 4: Ingestion, Idempotency, BullMQ Queues & Workers
- [x] `POST /v1/events` single event ingestion endpoint
- [x] Enable `rawBody: true` in NestJS application setup (`src/main.ts`)
- [x] `InboundModule`: CRUD for `inbound_sources`, public endpoint `POST /v1/inbound/:sourceSlug` with HMAC verification using `req.rawBody`
- [x] Inbound Pause/Resume endpoints (`POST /v1/inbound-sources/:id/pause` & `/resume`) with BullMQ rate-limited delivery
- [x] Support `PAUSED` delivery status in `DeliveryProcessor` worker and database schema
- [x] `IdempotencyInterceptor` using Redis `SET key PROCESSING NX EX 86400` pattern
- [x] Standalone Worker process entry point (`src/worker.ts`)
- [x] BullMQ Producers and Queue configuration (`events-queue`, `deliveries-queue`)
- [x] `DeliveryProcessor` worker with error classification (Fatal 4xx vs Retryable 429/5xx/Network) & exponential backoff with jitter
- [x] Audit trail recording into `delivery_attempts` database table
- [x] Graceful shutdown hooks (`SIGTERM` / `SIGINT`) in Worker process to complete active jobs

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
| ADL-004 | Prisma 7 Rust-Free ESM Client & Driver Adapter | Adopted Prisma 7.10 `prisma-client` ESM generator (`src/generated/prisma`), `prisma.config.ts`, `@prisma/adapter-pg` (`pg.Pool`), and native `partialIndexes` preview feature for partial unique idempotency index. | Approved |
| ADL-005 | Key Separation & Canonical AES-256-GCM Layout | Enforced separate `APP_SECRET` (min 32 chars) and `ENCRYPTION_MASTER_KEY` (64 hex chars / 32B) in Zod v4 env validation; standardized `CryptoService` on `[IV (12B) \| AuthTag (16B) \| CipherText]` packed layout plus detached Prisma column helpers. | Approved |
| ADL-006 | Atomic Redis Lua Refresh Token Rotation & Domain-Separated JWTs | Enforced distinct `JWT_ACCESS_SECRET` (15m, `type: 'access'`) and `JWT_REFRESH_SECRET` (7d, `type: 'refresh'`) in Zod v4 env validation, and implemented atomic single-roundtrip Redis `EVAL` Lua rotation on `auth:rt:family:{sid}` with OAuth 2.0 (RFC 9700) reuse detection that immediately revokes compromised session families. | Approved |
| ADL-007 | Strategy Provider Adapters, Prototype-Safe Templating/JsonLogic & Ajv Schema Engine | Standardized `WebhookAdapter`, `TelegramAdapter`, and `MailgunAdapter` on `AbortSignal.timeout(10_000)` (`SPEC.md` §3.3) with typed `ProviderDeliveryError` (`retryable` classification for Stage 4 BullMQ backoff vs fatal 4xx) and secret redaction; hardened `getByPath`, isolated `Handlebars.create()` (`allowProtoPropertiesByDefault: false`, `allowProtoMethodsByDefault: false` + null-prototype context cloning), and `json-logic-js` AST inspection against `__proto__`/`constructor`/`prototype` traversal while preserving `SPEC.md` `routing_rules` schema; integrated `Ajv` v8 + `ajv-formats` (`DISABLED` / `WARN` / `STRICT`) with RFC 9457 `HttpExceptionFilter` error arrays. | Approved |
| ADL-008 | Dual-Tier Atomic Idempotency, RawBody Constant-Time Inbound Gateway & BullMQ 6 Worker Isolation | Extracted producer-only `QueueModule` (`deliveries` + `deliveries-dlq`, `maxRetriesPerRequest: null`) so `AppModule` (`src/main.ts`) never mounts `@Processor` consumers, while `WorkerModule` (`src/worker.ts`) runs via `NestFactory.createApplicationContext` with idempotent `SIGTERM`/`SIGINT` drain; paired Redis `SET NX EX 86400` (`PROCESSING` lock + compare-and-delete Lua cleanup) with PostgreSQL partial unique index `(workspace_id, idempotency_key)` `P2002` recovery; implemented 5 raw-body `timingSafeEqual` inbound verifiers + atomic Redis ZSET Lua sliding-window rate limiting + two-layer `Pause`/`Resume` pacing (staggered BullMQ delays + worker `DelayedError` egress shaping); mapped fatal errors to BullMQ `UnrecoverableError` (`-1` backoff) and transient errors to `10s -> 1m -> 5m -> 30m -> 2h` jittered backoff. | Approved |

---

## Context Memory Buffer
This section is updated by the AI Agent after every successful execution session.

- **Last Session Date:** 2026-11-27
- **Active Stage:** Stage 5 (Stages 1–4 Completed)
- **Completed Milestones:** Stages 1–4 complete — Installed `bullmq` v6 & `@nestjs/bullmq` v12; added producer-only `QueueModule` (`deliveries` + `deliveries-dlq`), atomic Redis `SET NX EX`, compare-and-delete Lua, and ZSET sliding-window rate-limiter Lua primitives in `RedisService`, plus reusable `IdempotencyInterceptor`; implemented `EventsModule` (`IngestionModule`) with `POST /v1/events` (`202 Accepted` / `200 OK` on idempotent replay / `400 Bad Request` on `STRICT` schema failure, `WARN` persistence, rule fan-out transaction, `deliverAt` delayed scheduling, and `P2002` partial unique index fallback); implemented `InboundModule` (`POST`/`GET`/`DELETE` + `/pause` & `/resume` with `CryptoService.encryptDetached`, public `POST /v1/inbound/:sourceSlug` with `STRIPE`, `GITHUB`, `SHOPIFY`, `CUSTOM_HMAC`, and `NONE` constant-time `rawBody` verifiers, `429` + `Retry-After` rate limiting, and FIFO staggered drain on resume); implemented `WorkerModule` (`DeliveryProcessor` with credential decryption, template/BYOT resolution, inbound `WebhookAdapter` forwarding, masked `DeliveryAttempt` audit rows, `10s -> 1m -> 5m -> 30m -> 2h` jittered backoff, and `UnrecoverableError` fatal handling) and standalone `src/worker.ts` entrypoint (`start:worker`, `start:worker:dev`, `start:worker:prod`). Verified with `tsc --noEmit`, 28 Vitest suites (117 unit tests, 92.43% statement / 96.83% function coverage), and `npm run build` (`dist/main.js` & `dist/worker.js`).
- **Key Decisions Made:** Reused `RedisService.checkSlidingWindowRateLimit()` (atomic ZSET Lua script) for both inbound ingress throttling and per-source worker egress shaping (ready for Stage 5 global `RateLimitGuard`); used unique resume batch `jobId` suffixes on `/resume` to avoid BullMQ deduplicating previously paused job IDs while `DeliveryProcessor` enforces DB terminal-state idempotency (`DELIVERED`/`CANCELED`/`PAUSED`).
- **Known Blockers / Technical Debt:** Local host `~/.docker/config.json` references legacy `"credsStore": "desktop"` and lacks `cliPluginsExtraDirs` for Homebrew `docker-compose` (documented workaround for local CLI usage). Active shell Node is `v22.17.0` (`engines.node >= 22.12.0` configured alongside `@types/node@^26.6.7`).

---

## Agent Instructions for Updating Progress
1. Mark completed checklist items with `[x]` upon verifying green Vitest / typecheck runs.
2. Update `Context Memory Buffer` with date, active stage, decisions, and any tech debt identified.
3. Log significant architectural changes in the `Architecture Decision Log` table.
