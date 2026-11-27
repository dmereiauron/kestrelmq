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
- [x] BullMQ Producers and Queue configuration (`deliveries`, `deliveries-dlq`, `maintenance`)
- [x] `DeliveryProcessor` worker with error classification (Fatal 4xx vs Retryable 429/5xx/Network) & exponential backoff with jitter
- [x] Audit trail recording into `delivery_attempts` database table
- [x] Graceful shutdown hooks (`SIGTERM` / `SIGINT`) in Worker process to complete active jobs

### Stage 5: Streams, Cursor Pagination, Rate Limiting & Analytics
- [x] `POST /v1/events/bulk` endpoint with Node.js Stream parsing (`stream.pipeline`, `Transform`, backpressure handling)
- [x] High-performance Cursor-based (Keyset) Pagination for `DeliveriesService`
- [x] Replay and Cancellation endpoints (`POST /v1/deliveries/:id/replay`, `POST /v1/deliveries/:id/cancel`)
- [x] Redis Sliding Window Rate Limiting Guard backed by Redis ZSET
- [x] `AnalyticsService` with Cache-Aside aggregation pattern and 60s TTL
- [x] Plan-aware Data Retention repeatable job (`RetentionProcessor` with daily `cleanup-delivery-attempts` scheduler on `maintenance` queue: `FREE` 7d, `PRO` 30d, `ENTERPRISE` 90d)

### Stage 6: E2E Testing, Typed SDK, OpenAPI & Production Docker
- [x] E2E integration tests using Testcontainers (dynamic Postgres 18 + Redis 8.2 containers)
- [x] Simulation tests for Exponential Backoff retries on simulated 500 failures
- [x] `@kestrelmq/sdk` strongly typed TypeScript client wrapper in `sdk/` directory
- [x] Complete OpenAPI / Swagger setup (`/docs` route with `x-api-key` security scheme)
- [x] Production Multi-stage `Dockerfile` (Node 26 Alpine, non-root `USER node`, separate API/Worker entrypoints)
- [x] Final `README.md` update

### Stage 7: Official NestJS MCP Server (`@nestjs/mcp`)
- [x] `McpModule` setup (`@nestjs/mcp` + `@modelcontextprotocol/server`) over Streamable HTTP (`POST/GET/DELETE /mcp`) mounted in `AppModule` only (excluded from `WorkerModule`)
- [x] `ApiKeyGuard` (`Authorization: Bearer kmq_live_...`) workspace resolution and strict multi-tenant isolation on `/mcp`
- [x] MCP Tools (`@Tool`): `send_event`, `list_deliveries`, `inspect_delivery`, `replay_delivery`, `get_analytics_summary`, and `toggle_inbound_source`
- [x] MCP Resources (`@Resource`): `kestrelmq://schemas` (`EventSchemasService`) and `kestrelmq://templates` (`TemplatesService`)
- [x] Vitest unit test suites (`.spec.ts`) for MCP tools, resources, and workspace isolation
- [x] `README.md` MCP client setup instructions (Claude Code & Cursor)

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
| ADL-009 | Backpressure-Driven CSV Stream Ingestion, Keyset Cursor Pagination, Stampede-Guarded Cache-Aside Analytics & Bounded Retention Purging | Built `POST /v1/events/bulk` using `busboy` + `stream.pipeline` + RFC 4180 `CsvParserStream` (`Transform` in `readableObjectMode`) feeding an `objectMode` `Writable` sink that flushes `500`-row PostgreSQL `createMany` transactions and BullMQ `addBulk` enqueues before releasing stream callbacks for end-to-end TCP backpressure; enforced zero-`OFFSET` `(createdAt DESC, id DESC)` keyset pagination (`take: limit + 1`) with Base64URL cursors, replay with unique BullMQ `jobId` + cumulative retry budget (`attemptCount + maxAttempts`), and atomic `updateMany` cancellation; added plan-aware ZSET `RateLimitGuard` (`FREE`/`PRO`/`ENTERPRISE` with Redis plan caching), `AnalyticsService` (`PERCENTILE_CONT(0.95)`, `60s` Redis Cache-Aside + `SET NX EX` stampede lock), and isolated `maintenance` queue `RetentionProcessor` (`upsertJobScheduler` daily `0 3 * * *` purging `delivery_attempts` in bounded `1,000`-row batches per plan). | Approved |
| ADL-010 | Official NestJS MCP Server (`@nestjs/mcp`) & API-Key Tenant Isolation | Adopted `@nestjs/mcp` + `@modelcontextprotocol/server` (official MCP TypeScript SDK v2, the peer dependency of `@nestjs/mcp@0.0.5`) over Streamable HTTP (`/mcp`) in `AppModule` only (excluded from `WorkerModule`) gated by `ApiKeyGuard` (`kmq_live_...` -> `workspaceId`) to expose tenant-isolated operational `@Tool`s (`send_event`, `list_deliveries`, `inspect_delivery`, `replay_delivery`, `get_analytics_summary`, `toggle_inbound_source`) and discovery `@Resource`s (`kestrelmq://schemas`, `kestrelmq://templates`) reusing existing domain services with `maskSensitiveData` redaction and zero direct outbound HTTP calls. | Approved |
| ADL-011 | Dual-Scheme SDK/JWT Guard, Zero-Dependency ESM `@kestrelmq/sdk`, Testcontainers E2E Isolation & Multi-Stage Node 26 Alpine Image | Introduced `JwtOrApiKeyGuard` on `DeliveriesController` and `AnalyticsController` so server-side `@kestrelmq/sdk` clients (`kmq_live_...`) and browser RBAC sessions (`Bearer <jwt>` + `x-workspace-id`) share operational endpoints seamlessly; mounted OpenAPI 3.0 Swagger UI at `/docs` (`useGlobalPrefix: false`) with explicit DTO decorators (no AST plugin magic); built zero-dependency native-`fetch` `@kestrelmq/sdk` (`KestrelClient` + RFC 9457 `KestrelApiError`); isolated E2E Testcontainers (`postgres:18-alpine`, `redis:8.2-alpine`) via `ignoreEnvFile: NODE_ENV === 'test'`, dynamic module imports after container boot, Colima/OrbStack Docker context auto-discovery, and `BACKOFF_SCALE_FACTOR`; packaged a 3-stage `node:26-alpine` `Dockerfile` running as non-root `USER node` supporting both `node dist/main.js` and `node dist/worker.js`. | Approved |
| ADL-012 | Dual-Layer MCP Auth, Prefix-Excluded Stateless Endpoint & MCP-Aware Global Enhancers | Mounted `KestrelMcpModule` (`McpModule.forRoot` with `include: [McpPrimitivesModule]`) at `/mcp` via `setGlobalPrefix('v1', { exclude: ['mcp'] })` in `main.ts` and the E2E harness. Kept the default stateless Streamable HTTP mode (`GET`/`DELETE` -> `405`) for load-balancer-friendly scaling. Gated the endpoint controller with `decorators: [UseGuards(ApiKeyGuard, RateLimitGuard), ApiExcludeController()]`, so unauthenticated requests (including `initialize`/`tools/list`) get an RFC 9457 `401` and MCP traffic counts against the workspace sliding-window quota. Re-applied `ApiKeyGuard` at call level on every tool/resource class; it reads the request via `McpExecutionContext.getRequest()` and returns early when the endpoint pass already resolved the same request. This layer is also what the in-memory `connectMcpClient` exercises. Tenant scope comes only from `request.workspaceId` (`resolveMcpWorkspaceId`), and all tool input schemas are `z.strictObject`, so a client-supplied `workspaceId` is rejected. Made the global `HttpExceptionFilter` rethrow on `host.getType() === 'mcp'` (masked logging for non-HTTP errors), so `@nestjs/mcp` maps errors to `isError` tool results / JSON-RPC errors instead of writing problem+json into the JSON-RPC stream. Added an MCP branch to `LoggingInterceptor` (masked input, no result body). Tool args are typed as `z.infer` aliases, so the global `ValidationPipe` (metatype `Object`) is a no-op and Zod is the single validator. | Approved |

---

## Context Memory Buffer
This section is updated by the AI Agent after every successful execution session.

- **Last Session Date:** 2026-11-27
- **Active Stage:** All stages complete (Stages 1–7)
- **Completed Milestones:** Stage 7 complete. Added the official `@nestjs/mcp@0.0.5` + `@modelcontextprotocol/server@2.4` Streamable HTTP server at `/mcp` (`src/modules/mcp/`: `KestrelMcpModule`, `McpPrimitivesModule`, `EventTools`, `DeliveryTools`, `AnalyticsTools`, `InboundTools`, `WorkspaceResources`, `resolveMcpWorkspaceId`). It provides 6 tools (`send_event`, `list_deliveries`, `inspect_delivery`, `replay_delivery`, `get_analytics_summary`, `toggle_inbound_source`) and 2 resources (`kestrelmq://schemas`, `kestrelmq://templates`), delegating to existing domain services. Added the `extractTemplateVariables` Handlebars AST util. Made `ApiKeyGuard`, `HttpExceptionFilter` and `LoggingInterceptor` MCP-context aware. Tests: unit specs for all tools/resources/util, a `connectMcpClient` integration spec (tenant isolation, invalid keys, injected `workspaceId`, worker module graph excludes MCP), and E2E Flow 6 (real Streamable HTTP client: 401/404/429, `send_event` -> worker DELIVERED, cross-tenant not found). Updated `README.md` (MCP Server Integration with Claude Code `.mcp.json` / CLI and Cursor configs) and `docs/SPEC.md` (§2, §5, §6, §7.1).
- **Key Decisions Made:** Used `@modelcontextprotocol/server` instead of `@modelcontextprotocol/sdk` because `@nestjs/mcp` peer-depends on SDK v2 (`/server` + `/client`). Put tool/resource providers in a separate `McpPrimitivesModule` so `McpModule.forRoot({ include })` does not self-reference its host module. `kestrelmq://templates` joins `RulesService.listRules` with `IntegrationsService.listIntegrations` for channels, so no new queries or schema changes were needed. The E2E MCP flow uses a second workspace because Flow 5 intentionally exhausts the primary workspace quota, which also proves `/mcp` is rate limited. See ADL-012.
- **Known Blockers / Technical Debt:** `@nestjs/mcp` is pre-1.0 (`0.0.5`), so pin it and review its changelog on upgrade. `http.allowedOrigins` keeps its localhost-only default: browser-origin MCP clients on other hosts are refused with 403, while non-browser agents (no `Origin` header) are unaffected. `send_event` over MCP does not accept an `Idempotency-Key` header; deduplication uses the `idempotencyKey` argument.

---

## Agent Instructions for Updating Progress
1. Mark completed checklist items with `[x]` upon verifying green Vitest / typecheck runs.
2. Update `Context Memory Buffer` with date, active stage, decisions, and any tech debt identified.
3. Log significant architectural changes in the `Architecture Decision Log` table.
