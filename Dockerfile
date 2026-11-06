# syntax=docker/dockerfile:1
#
# Konnected app image. One image, three uses (see docker-compose.prod.yml):
#   app      node server.js                              (Next.js standalone server, port 3000)
#   worker   payload jobs:run --cron ... (in /app/cli)   (background jobs, one container)
#   migrate  payload migrate             (in /app/cli)   (one-off, before each deploy)
#
# No secrets go into this image or its build arguments. Runtime settings come from the
# environment (docker-compose.prod.yml and the server's .env.prod). Only NEXT_PUBLIC_* values may
# ever be build arguments, because Next.js writes them into the browser code.

# Pinned: Node 24 (Payload needs ^22.23.4 || >=24.22.1), Debian slim (glibc, for sharp).
ARG NODE_IMAGE=node:24.22.1-slim

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1
# The pnpm version from "packageManager" in package.json.
RUN npm install --global pnpm@12.16.1 && npm cache clean --force
WORKDIR /app

# All dependencies, to build.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=konnected-pnpm,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store

# Production dependencies only, for the Payload CLI (migrations and the job worker). The Next.js
# standalone output keeps only the files the server itself uses, which is not enough for the CLI.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=konnected-pnpm,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm-store \
    # The CLI never loads the admin panel's code editor or the Next.js compiler (about 200 MB).
    && rm -rf node_modules/.pnpm/monaco-editor@* node_modules/.pnpm/@next+swc-*

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
# The app has no public/ folder yet; create it so the runtime COPY below always works.
RUN mkdir -p public && pnpm build

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MEDIA_DIR=/data/media
WORKDIR /app

# The server. Files stay owned by root, so the app user cannot change its own code.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# The Payload CLI: production node_modules plus the TypeScript source it loads with tsx.
COPY --from=prod-deps /app/node_modules ./cli/node_modules
COPY --from=builder /app/package.json /app/tsconfig.json ./cli/
COPY --from=builder /app/src ./cli/src

# Writable places for the non-root user: the Next.js cache and the uploads volume.
RUN mkdir -p .next/cache /data/media \
    && chown node:node .next/cache /data/media

USER node
EXPOSE 3000

# /api/health checks the database. Slim images have no curl, so Node does the request.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
