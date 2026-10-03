# syntax=docker/dockerfile:1
# Liveforge server + dashboard. Build: docker build -t liveforge .   Run: docker compose up (see docs/self-hosting.md)

# ---- build: compile TypeScript, emit JSON Schemas, build the dashboard
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 compiles a native addon when no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples
RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

# ---- runtime
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    LIVEFORGE_DB=/data/liveforge.sqlite \
    LIVEFORGE_DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/examples ./examples
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
