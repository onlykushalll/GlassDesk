# syntax=docker/dockerfile:1
# GlassDesk Production Multi-Stage Dockerfile

# ==========================================
# Stage 1: Base & Dependencies
# ==========================================
FROM oven/bun:1.1-alpine AS deps
WORKDIR /app

# Install root dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install session-service dependencies
WORKDIR /app/mini-services/session-service
COPY mini-services/session-service/package.json mini-services/session-service/bun.lock ./
RUN bun install --frozen-lockfile

# ==========================================
# Stage 2: Next.js Frontend Builder
# ==========================================
FROM oven/bun:1.1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client if present
RUN if [ -f "./prisma/schema.prisma" ]; then bun x prisma generate; fi

# Build Next.js application
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN bun run build || (bun x next build)

# ==========================================
# Stage 3: Unified Production Runner
# ==========================================
FROM oven/bun:1.1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV SESSION_PORT=4000
ENV NEXT_TELEMETRY_DISABLED=1

# Create unprivileged application user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    mkdir -p /app/db /app/data && \
    chown -R nextjs:nodejs /app/db /app/data

# Copy session-service
COPY --from=deps --chown=nextjs:nodejs /app/mini-services/session-service/node_modules ./mini-services/session-service/node_modules
COPY --chown=nextjs:nodejs mini-services/session-service ./mini-services/session-service

# Copy Next.js assets
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json

USER nextjs

EXPOSE 3000 4000

# Start both services via concurrently / background runner
CMD ["sh", "-c", "cd /app/mini-services/session-service && bun run index.ts & cd /app && bun run start"]
