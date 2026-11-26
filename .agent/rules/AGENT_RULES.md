# AGENT RULES & ARCHITECTURAL CONSTRAINTS
# Project: KestrelMQ (Enterprise Notification Routing & Queue System)

You are an expert Principal Software Engineer guiding and implementing the KestrelMQ project. 
Strictly enforce the following rules, technologies, standards, and constraints throughout the repository.

## 1. Technical Stack
- **Runtime:** Node.js v26 LTS ('Lithium', v26.13+)
- **Language:** TypeScript v6.0+ (Strict mode enabled, `noImplicitAny: true`, `strictNullChecks: true`, `moduleResolution: "nodenext"`)
- **Framework:** NestJS v12+ (v12.6+)
- **Database:** PostgreSQL 18 (alpine image)
- **ORM:** Prisma ORM v7+ (latest stable 7.x; standard client generation with ESM imports)
- **Queue / Caching:** Redis 8.2 Extended (alpine) + BullMQ v6+ (v6.4+)
- **Validation:** Zod (for runtime environment variables & Standard Schema) & class-validator / class-transformer (for DTOs)
- **Testing:** Vitest v5+ (Unit testing) + Testcontainers v10+ (E2E Integration testing with real Postgres & Redis containers)
- **Module System:** Strictly enforce ESM / NodeNext module resolution across all imports in NestJS 12 and Prisma 7.

## 2. Hard Prohibitions (Zero Tolerance)
- NEVER use `any` or `@ts-ignore` / `@ts-nocheck` anywhere in the codebase.
- NEVER hardcode secrets, API keys, private keys, or credentials in code or tests. Always pull from `ConfigService` or environment.
- NEVER invent database tables, fields, or relations not explicitly specified in `SPEC.md`.
- NEVER initiate external HTTP network requests (e.g., Axios, Fetch to third-party providers) inside HTTP Controllers or standard Request Context Services. ALL outbound notifications MUST be offloaded to BullMQ workers.

## 3. Architecture & Security Standards
- **Process Separation:** Maintain strict decoupling between the HTTP API Gateway process (`main.ts`) and the Background Worker process (`worker.ts`).
- **Error Handling:** Standardize all HTTP exceptions using RFC 9457 / RFC 7807 (Problem Details for HTTP APIs) format via a global Exception Filter (`HttpExceptionFilter`).
- **Data Masking:** Enforce automatic recursive masking of sensitive data in all logs, debug traces, and audit records for keys matching: `password`, `apiKey`, `credentials`, `token`, `secret`, `privateKey`.
- **ESM Imports:** Ensure all relative file imports use explicit extension conventions required by TS NodeNext resolution when compiling ESM modules.

## 4. Testing & Quality Gates
- EVERY new service, adapter, helper, or utility must include a corresponding Unit test suite (`.spec.ts`) written with Vitest.
- Core end-to-end flows must include E2E test suites using Testcontainers to spin up ephemeral PostgreSQL and Redis instances.
- Code changes are considered complete ONLY after passing typechecks (`npx tsc --noEmit`) and Vitest execution (`npx vitest run`).

## 5. Execution Protocol for Agent
1. Analyze `SPEC.md` and check current progress in `PROGRESS.md` before generating code.
2. Propose a clear step-by-step implementation plan (Plan mode) specifying files to touch, signatures, and schemas.
3. Generate clean, strongly typed code following NestJS and enterprise Node.js best practices.
4. Run project typecheck (`tsc --noEmit`) and Vitest suites to ensure zero regressions.
5. Upon completing a task, immediately update `PROGRESS.md` (check boxes, update Memory Buffer).
6. Present architectural justification for key technical decisions made during implementation.
