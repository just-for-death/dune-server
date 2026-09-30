# ── Stage 1: Build backend TypeScript ─────────────────────────────────
FROM node:20-alpine AS backend-builder

WORKDIR /build

COPY backend/package*.json ./backend/
RUN cd backend && npm ci --ignore-scripts

COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
RUN cd backend && npx tsc

# ── Stage 2: Production dependencies ────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ── Stage 3: Runtime ────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Security: upgrade + minimal tools (unzip/zip for save extraction)
RUN apk update && apk upgrade --no-cache \
  && apk add --no-cache unzip zip tini \
  && rm -rf /var/cache/apk/*

# Non-root user for security
RUN addgroup -S dune && adduser -S dune -G dune

WORKDIR /app/backend

# Copy production node_modules
COPY --from=deps /app/backend/node_modules ./node_modules

# Copy built backend
COPY --from=backend-builder /build/backend/dist ./dist
COPY backend/package.json ./

# Copy pre-built frontend (built separately via Vite)
# If frontend/dist exists in build context, use it; otherwise serve API only
COPY frontend/dist ./frontend/dist

# Data directories (mounted as volumes in production)
RUN mkdir -p /app/backend/data/saves /app/backend/data/hltb-cache \
  && chown -R dune:dune /app/backend

USER dune

ENV NODE_ENV=production
ENV PORT=3030
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3030/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
