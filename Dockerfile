# syntax=docker/dockerfile:1
# Reactive (server + dashboard + the Livecraft demo game) as one image.
#   docker build -t reactive .        docker compose up --build        Render: render.yaml (docs/self-hosting.md)
# The runtime serves the API at /v1, WebSockets at /v1/ws, the dashboard at /dashboard and, when
# LIVEFORGE_STATIC_DIR=/app/examples/livecraft/dist is set (render.yaml does), the Livecraft game at /.

# ---- build: compile TypeScript, emit JSON Schemas, build the dashboard and Livecraft
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 compiles its native addon when no prebuilt binary matches (build stage only)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
# the dashboard's demo mode bundles examples/counterforge.liveforge.yaml, so the manifests come in before the build
COPY examples/*.liveforge.yaml ./examples/
RUN npm run build
COPY examples ./examples

# Livecraft: its prebuild links @liveforge/* from ../.. (this repo). The publishable key is baked in at build time;
# it must match LIVEFORGE_SDK_KEYS on the server (livecraft=<key>).
ARG VITE_LIVEFORGE_KEY=pk_live_livecraft
WORKDIR /app/examples/livecraft
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi \
  && VITE_LIVEFORGE_KEY="$VITE_LIVEFORGE_KEY" npm run build

# Runtime tree: production deps, each package's package.json + dist (+ schema), the manifests, the game build
WORKDIR /app
RUN npm prune --omit=dev --no-audit --no-fund \
  && mkdir -p /out/packages /out/examples/livecraft \
  && cp package.json /out/ && cp -a node_modules /out/ \
  && for d in packages/*; do \
       n="$(basename "$d")"; mkdir -p "/out/packages/$n"; cp "$d/package.json" "/out/packages/$n/"; \
       for x in dist schema; do if [ -d "$d/$x" ]; then cp -a "$d/$x" "/out/packages/$n/"; fi; done; \
     done \
  && cp examples/*.liveforge.yaml /out/examples/ \
  && cp -a examples/livecraft/dist /out/examples/livecraft/dist

# ---- runtime
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    LIVEFORGE_DB=/data/liveforge.sqlite \
    LIVEFORGE_DATA_DIR=/data
COPY --from=build --chown=node:node /out ./
RUN mkdir -p /data && chown node:node /data
USER node
# PORT is overridden by the platform (Render sets it); mount a volume on /data to keep the SQLite file
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
