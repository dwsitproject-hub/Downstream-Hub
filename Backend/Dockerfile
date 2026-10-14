# Downstream Hub — Backend API (Node.js / Express)
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Build / development (optional if we add TypeScript build)
FROM base AS builder
COPY package*.json ./
RUN npm install
COPY . .
# RUN npm run build  # uncomment when backend has a build step

# Production runner
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
# Admin scripts (e.g. `node scripts/service-key.js`), run with `docker exec`
COPY --from=builder /app/scripts ./scripts
# Non-root user cannot mkdir under root-owned /app; uploads must exist and be writable
RUN mkdir -p /app/uploads/app-icons && chown -R nodejs:nodejs /app/uploads
USER nodejs
EXPOSE 4000
CMD ["node", "src/server.js"]
