# ============================================================
# Budget-Pal Frontend Dockerfile
# Multi-stage: node:18-alpine build → nginx:alpine serve
# ============================================================

# ── Stage 1: Build ────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

# Build argument for API base URL (set at build time)
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

# Install dependencies first (cache layer)
COPY package.json package-lock.json* ./
RUN npm ci --prefer-offline 2>/dev/null || npm install

# Copy source and build
COPY . .
RUN npm run build

# ── Stage 2: Serve ────────────────────────────────────────────
FROM nginx:1.25-alpine AS runtime

# Remove default nginx config
RUN rm -rf /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Add non-root user (nginx still binds port 80 as root inside container)
RUN chown -R nginx:nginx /usr/share/nginx/html

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/ || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
