# syntax=docker/dockerfile:1
ARG NODE_VERSION=26-alpine

# -----------------------------------------------------------------------------
# Stage 1: Install deterministic dependency tree
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# -----------------------------------------------------------------------------
# Stage 2: Generate Prisma 7 ESM client, compile NestJS + SDK, prune devDeps
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY sdk ./sdk

RUN npm run build && npm run sdk:build && npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 3: Hardened non-root production runtime (API & Worker entrypoints)
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma

USER node
EXPOSE 3000

# Default entrypoint runs the HTTP API Gateway (src/main.ts -> dist/main.js).
# Run the standalone BullMQ Worker with: docker run ... <image> node dist/worker.js
CMD ["node", "dist/main.js"]
