FROM node:20.19-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts

FROM node:20.19-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time placeholders only (satisfy env validation during `next build`).
# Real secrets come from compose env_file at runtime — do not bake them here.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/builddb \
    NEXTAUTH_URL=https://build.invalid \
    NEXTAUTH_SECRET=docker-build-only-nextauth-secret-value \
    UPSTASH_REDIS_REST_URL=https://build.upstash.invalid \
    UPSTASH_REDIS_REST_TOKEN=docker-build-only-upstash-token-value \
    CRON_SECRET=docker-build-only-cron-secret-value-32 \
    npm run build

FROM node:20.19-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Patch the base image's Alpine packages (openssl, musl, zlib) up to the
# fixed releases within the same Alpine branch, then remove the package
# managers. The runtime only ever executes 'node server.js', so npm, yarn
# and corepack contribute nothing to it except their own vulnerable bundled
# dependencies (node-tar, minimatch, brace-expansion, cross-spawn, glob).
#
# CI builds with a layer cache. A cached copy of this step would keep serving
# the packages from whenever it last ran, so CI passes a value that changes on
# every run (SECURITY_UPGRADE_KEY) and the upgrade always runs fresh. A plain
# `docker build` leaves it empty, which changes nothing.
ARG SECURITY_UPGRADE_KEY=""
RUN echo "Alpine package upgrade key: ${SECURITY_UPGRADE_KEY:-none}" \
  && apk --no-cache upgrade \
  && apk add --no-cache libc6-compat \
  && rm -rf /usr/local/lib/node_modules/npm \
            /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm \
            /usr/local/bin/npx \
            /usr/local/bin/corepack \
            /usr/local/bin/yarn \
            /usr/local/bin/yarnpkg \
            /opt/yarn-v* \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Bcrypt runs on the libuv threadpool. 4 is the libuv default (so this is a
# no-op today); raise it toward the container CPU limit in docker-compose.yml
# if that limit is increased, otherwise the extra threads only contend.
ENV UV_THREADPOOL_SIZE=4
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
