# Headroom: one image that serves the API and the built web app
# (HANDOFF section 10 and 11).
#
# Base image is pinned, the final stage runs as a non-root user, and the build
# context deliberately excludes `.env`, the real seed, the reference scan and
# the mockups (see .dockerignore).
#
# Node 22 here rather than the 20.19.0 used for local development: Node 20 is
# past end-of-life and this container is reachable from the household's phones.
# Every pinned dependency supports both, and CI runs the tests on both.

ARG NODE_VERSION=22.23.4-alpine3.22

# ---------------------------------------------------------------- base ------
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pinned to the pnpm version in package.json's packageManager field.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---------------------------------------------------------------- deps ------
# Manifests only, so this layer is cached until a dependency actually changes.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --------------------------------------------------------------- build ------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/api apps/api
COPY apps/web apps/web
# core first: the API and the web app both import it.
RUN pnpm -F @headroom/core build \
 && pnpm -F @headroom/api build \
 && pnpm -F @headroom/web build

# ------------------------------------------------------- runtime deps -------
FROM base AS runtime-deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ------------------------------------------------------------- runtime ------
FROM base AS runtime

ENV NODE_ENV=production
# Saskatchewan time, no daylight saving. The server clock is authoritative for
# every timestamp Headroom stores (HANDOFF section 16.1 rule 10).
ENV TZ=America/Regina
ENV PORT=3000
ENV HOST=0.0.0.0
ENV WEB_DIST_DIR=/app/apps/web/dist

# tzdata so TZ resolves to real rules; wget is used by the health check.
RUN apk add --no-cache tzdata

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=runtime-deps /app/apps/api/node_modules ./apps/api/node_modules

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# Needed at runtime: `prisma migrate deploy` runs on start, and Prisma 7 reads
# the connection string from prisma.config.ts rather than from the schema.
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts

COPY docker/entrypoint.sh /usr/local/bin/headroom-entrypoint
RUN chmod +x /usr/local/bin/headroom-entrypoint

# `node` (uid 1000) ships with the base image. Running as root would let a
# compromised process rewrite the app it is serving.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Compose and Unraid both use this to tell "started" from "actually serving".
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/usr/local/bin/headroom-entrypoint"]
CMD ["node", "apps/api/dist/server.js"]
