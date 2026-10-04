# Self-hosting

Reactive is one Node process. It holds the HTTP API, the WebSocket hub, the SQLite event log and the dashboard.
Run it next to your game servers, on a small VPS, or on your laptop at a game jam.

## Requirements

- **Node 22+.** `better-sqlite3` ships prebuilt binaries for common platforms. Elsewhere it compiles, which needs
  Python 3 and a C++ toolchain.
- **Resources:** about 100 MB of RAM at hackathon scale. Projection state is held in memory and checkpointed to
  SQLite.
- **No provider keys required.** Without them, every ask is answered by rules and cache.

## Node

```bash
npm install
npm run build            # TypeScript, JSON Schemas and the dashboard
cp .env.example .env     # edit: keys, manifests
npm start                # node packages/server/dist/main.js   (or `npm run dev` for watch mode)
```

- **The server:** `http://localhost:8787`.
- **The dashboard:** `http://localhost:8787/dashboard`.
- **Liveness:** `GET /health`.
- **Configuration:** the server reads `.env` from the working directory (existing env vars win).

Run it under a process manager (systemd, pm2) and put it behind TLS. The dashboard and SDKs work with
`https://`/`wss://` unchanged.

```ini
# /etc/systemd/system/liveforge.service
[Service]
WorkingDirectory=/opt/liveforge
ExecStart=/usr/bin/node packages/server/dist/main.js
EnvironmentFile=/opt/liveforge/.env
Environment=NODE_ENV=production
Restart=always
```

## Docker

```bash
docker compose up --build            # http://localhost:8787
```

The repo ships these files:

| File | |
|---|---|
| `Dockerfile` | A two-stage Node 22 image. It builds everything, runs as `node`, keeps data in `/data` and has a `/health` healthcheck. |
| `docker-compose.yml` | Starts in **dev mode** for local trials: SDK key `pk_dev_<gameId>`, admin key `dev-admin`. |

For anything other people can reach, create a `.env` next to the compose file:

```bash
LIVEFORGE_DEV=0
LIVEFORGE_ADMIN_KEY=<long random string>
LIVEFORGE_SDK_KEYS=my_game=pk_live_abc123
LIVEFORGE_MANIFESTS=liveforge.yaml
ANTHROPIC_API_KEY=...
```

Then uncomment the `./liveforge.yaml:/app/liveforge.yaml:ro` volume line in `docker-compose.yml`. Data
(SQLite plus generated GLBs) lives in the `liveforge-data` volume.

## Environment variables

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `LIVEFORGE_MANIFESTS` | `liveforge.yaml` | Comma-separated manifest files, one game each. |
| `LIVEFORGE_DB` | `data/liveforge.sqlite` | SQLite file (`:memory:` allowed). |
| `LIVEFORGE_DATA_DIR` | `data` | Generated assets (GLBs). |
| `LIVEFORGE_SDK_KEYS` | none | Publishable keys per game: `game=key1\|key2,other=key3`. |
| `LIVEFORGE_ADMIN_KEY` | none | Dashboard and `/admin/*`. Covers every game. |
| `LIVEFORGE_DEV` | on unless `NODE_ENV=production` | With no keys set, accept `pk_dev_<gameId>` and `dev-admin`. |
| `LIVEFORGE_CORS_ORIGINS` | `*` | Comma-separated origins for browser games. |
| `LIVEFORGE_RATE_LIMIT_PER_MIN` | `600` | Per SDK key. |
| `LIVEFORGE_LOG_LEVEL` | `info` | `debug \| info \| warn \| error`. |
| `LIVEFORGE_FLUSH_MS` | `2000` | Projection checkpoint interval. |
| `LIVEFORGE_ACTIVE_WORLD_MS` | `1800000` | A world counts as active (ticks run: rumour spread, pacing) for 30 minutes after its last event. |
| `LIVEFORGE_DASHBOARD_DIR` | `packages/dashboard/dist` | Serve a different dashboard build. |
| **LLM** | | |
| `ANTHROPIC_API_KEY` | none | Enables AI upgrades (Claude). |
| `LIVEFORGE_LLM_PROVIDER` | `claude` | `none` disables the LLM even if a key is set. |
| `LIVEFORGE_MODEL_FAST` / `LIVEFORGE_MODEL_RICH` | from the manifest | Override model tiers. |
| `LIVEFORGE_LLM_TIMEOUT_MS` | `8000` | Upgrade timeout. The instant answer has already been sent. |
| `LIVEFORGE_LLM_STRUCTURED_MODE` | `output_config` | Or `strict_tool`. |
| `LIVEFORGE_LLM_EFFORT` | `low` | For models that support effort. |
| `LIVEFORGE_REFUSAL_FALLBACK` | `1` | Server-side refusal fallbacks where supported. |
| `LIVEFORGE_PRICES` | built-in table | JSON `{"model": [inputUsdPerM, outputUsdPerM]}` used for cost meters and $ budgets. |
| **Speech-to-text** | | |
| `LIVEFORGE_STT` | auto | `openai \| whispercpp \| none`. Auto-detected from the keys below. |
| `OPENAI_API_KEY`, `OPENAI_STT_MODEL`, `OPENAI_BASE_URL` | none, `whisper-1`, OpenAI | Whisper API (or any compatible endpoint). |
| `WHISPER_CPP_BIN`, `WHISPER_CPP_MODEL`, `WHISPER_CPP_THREADS` | none, none, `4` | Local whisper.cpp (fully offline). |
| `FFMPEG_BIN` | none | Lets whisper.cpp accept non-WAV audio (browser WebM/OGG). |
| `LIVEFORGE_STT_MAX_BYTES` | 10 MB | Upload cap. |
| **3D** | | |
| `HYPER3D_API_KEY`, `HYPER3D_BASE_URL`, `HYPER3D_POLL_MS` | none | Hyper3D Rodin mesh jobs. These also need `clamps.forge.meshJobs: true` in the manifest. |

## Providers

| Capability | Provider | Without it |
|---|---|---|
| Text (barks, replies, moves, forge, quests, profiles) | Claude: Haiku tier for fast tasks, Sonnet tier for rich ones | Rules and cache answers only. Everything still works. |
| Speech-to-text | OpenAI Whisper API, or local whisper.cpp | Use browser speech recognition (the JS SDK's `Mic` does this automatically), or typed text. |
| Text-to-speech | The SDK uses the engine: `speechSynthesis` in browsers, `DisplayServer.tts_speak` in Godot | — |
| 3D meshes | Hyper3D Rodin (async; a blueprint stand-in is shown until the mesh is ready) | Blueprint models only. |

Model and provider keys exist **only** in server env. Clients only ever hold the publishable game key.

## Costs and budgets

Reactive is built so that the bill stays boring:

- **Instant first.** Every ask is answered by rules or cache, and the AI is an upgrade. When a budget runs out,
  the game keeps working and only the upgrades pause.
- **Model tiering.** The fast tier (Haiku) handles barks, replies, moves and forge. The rich tier (Sonnet) only
  handles profiles, quests and lore-heavy tasks. Move kinds between tiers with `models.overrides`.
- **Cache and dedupe.** Identical asks are served from cache (exact key plus a normalised key). Bark pools are
  pre-generated and refilled in the background.
- **Budgets per game and per player:**

  ```yaml
  budgets:
    game:   { tokensPerMin: 200000, usdPerDay: 20 }
    player: { tokensPerMin: 20000,  usdPerDay: 1 }
  ```

- **Watch it live.** The dashboard's **Cost & latency** panel shows, per module:
  - asks, cache hits, and p50/p95 latency for instant answers and for upgrades;
  - tokens and $;
  - the game budget gauges.

  The same numbers come from `GET /admin/stats`.

At the default Haiku list price ($1 in / $5 out per million tokens), a typical bark or reply upgrade costs about
2k input and 150 output tokens, roughly $0.003. A player chatting constantly for an hour costs cents. The
per-player `usdPerDay` budget caps the worst case.

## Data, backups and snapshots

- **Storage:** everything is in one SQLite file (`LIVEFORGE_DB`, WAL mode). Back it up like any SQLite database:
  `sqlite3 liveforge.sqlite ".backup backup.sqlite"`.
- **Per-world snapshots:** `GET /v1/snapshot?world=…` exports the event log and projections, and
  `POST /v1/snapshot` imports one. Import replaces the world and rebuilds it.
- **Rebuilding:** `POST /admin/rebuild` replays the log into fresh projections, for example after changing a
  manifest rule.

## Scaling notes

- **One process per deployment:** at hackathon scale, one process handles many games and worlds.
- **In-memory state:** pending long-poll upgrades and rate-limit counters live in memory, so a restart drops them.
  The SDKs retry, so this is harmless.
- **Workers:** the core is not Workers-compatible yet. SQLite, `ws` and the file system are Node-only. A
  D1/Durable Objects store adapter is the path there.
