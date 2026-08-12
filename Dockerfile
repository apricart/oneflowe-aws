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
ARG DATABASE_URL=postgresql://build:build@127.0.0.1:5432/builddb
ARG NEXTAUTH_URL=https://build.invalid
ARG NEXTAUTH_SECRET=docker-build-only-nextauth-secret-value
ARG UPSTASH_REDIS_REST_URL=https://build.upstash.invalid
ARG UPSTASH_REDIS_REST_TOKEN=docker-build-only-upstash-token-value
ARG CRON_SECRET=docker-build-only-cron-secret-value-32

ENV DATABASE_URL=$DATABASE_URL \
    NEXTAUTH_URL=$NEXTAUTH_URL \
    NEXTAUTH_SECRET=$NEXTAUTH_SECRET \
    UPSTASH_REDIS_REST_URL=$UPSTASH_REDIS_REST_URL \
    UPSTASH_REDIS_REST_TOKEN=$UPSTASH_REDIS_REST_TOKEN \
    CRON_SECRET=$CRON_SECRET

RUN npm run build

FROM node:20.19-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
