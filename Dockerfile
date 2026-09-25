# syntax=docker/dockerfile:1
# One image = API + built client (same origin: no CORS, no third-party cookies).
# Build:  docker build -t ziptv .
# Run:    docker run -p 8080:8080 -e MONGO_URI=... -e STREAM_TOKEN_SECRET=... ziptv

# ---- 1. Build server + client (needs dev dependencies) --------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN npm ci --include=dev --no-audit --no-fund
COPY packages packages
COPY apps apps
# Empty = the client calls /api on the origin that serves it.
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build -w @ziptv/server && npm run build -w @ziptv/client

# ---- 2. Production dependencies of the server only --------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN npm ci --omit=dev --workspace @ziptv/server --include-workspace-root=false --no-audit --no-fund \
 && npm cache clean --force

# ---- 3. Runtime -------------------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    CLIENT_DIST_DIR=/app/client
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./server/package.json
COPY --from=build /app/apps/server/dist ./server
COPY --from=build /app/apps/client/dist ./client
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz > /dev/null || exit 1
# node directly (not npm) so SIGTERM reaches the process and graceful shutdown runs.
CMD ["node", "--enable-source-maps", "server/main.js"]
