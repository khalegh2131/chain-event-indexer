# NOTE: no `# syntax=` directive on purpose. This Dockerfile uses only features of
# the built-in frontend (multi-stage COPY --from, no heredocs, no --mount), so the
# build never needs to pull an external Dockerfile frontend image from a registry.

# ---------------------------------------------------------------------------
# Stage 1: full dependency tree (needed to compile TypeScript)
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2: build the TypeScript sources into dist/
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: production-only dependencies
# ---------------------------------------------------------------------------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 4: runtime image (non-root, healthchecked)
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    CONFIG_PATH=/app/config/config.json

WORKDIR /app

RUN apk add --no-cache wget \
  && addgroup -S -g 10001 indexer \
  && adduser -S -u 10001 -G indexer indexer

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY config ./config
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh \
  && mkdir -p /app/config \
  && chown -R indexer:indexer /app

USER indexer

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -q -O- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
