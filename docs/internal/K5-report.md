# K5 report: Dashboard + docs

**Status:** done. `npm run typecheck` and `npm run build` pass. The root build now includes the dashboard Vite
build. Per the user rules, no tests were written or run, and there was no browser or server smoke run. Nothing
was rendered or exercised at runtime. No key files were read and no live API calls were made.

## What was built

### Dashboard (`packages/dashboard`)

Built with Vite 8, TypeScript and Three.js, with no framework. It is served by the server at `/dashboard`.

**Entry and app state:**
- `src/main.ts` holds the login and app shell:
  - **Sign-in:** admin-key login (the key stays in session storage, or `localStorage` with "remember"), or
    **Explore with demo data** (also reachable at `?demo`).
  - **Top bar:** world and player pickers, the connection status (live / polling / offline / demo) and the
    signals-per-minute rate.
  - **Routing:** a hash router.
- `src/app.ts` holds the state, a pub/sub bus, the live ring buffers and the tracking of `boss.move_added`
  replacements.

**Data access:**
- `src/api/admin.ts`: `AdminClient` (typed fetch) and `LiveSource`.
  - Every route used is listed in `ADMIN_ROUTES`. The client follows CONTRACTS §9.
  - Review, bake and pack use the Forge module routes `/admin/m/forge/{bake,review,pack}`, falling back to core
    `/admin/review` and `/admin/bake`.
  - Live updates come from the WS admin firehose (topics `events` + `directives`). While the socket is down, the
    client polls `/admin/events?after=`, and it reconnects with backoff.
- `src/api/demo.ts`: `DemoSource`, an in-browser simulation driven by `examples/counterforge.liveforge.yaml`.
  - It folds into the same projection shapes as the server: traits with evidence, moments, profile, NPC memories,
    rumours that spread and mutate, factions, Director tension, aggression and a two-stage boss move, the gallery
    with real Blueprint v1 models, quests, achievements, the review/bake queue and meters.
  - It shows ten minutes of seeded history, plus an ambient player.

**Panels (12):** Overview, Signal stream, Simulate, Player model, NPC memories, Rumours (force graph), Factions
(heatmap + relationship graph), Director, Gallery (Three.js), Review & bake (with a bake-mode generator), Cost &
latency, and Manifest validator. The in-browser `parseManifest` gives click-to-line errors.

**Visualisation (`src/viz/`):**
- a Three.js Blueprint v1 builder: all 11 shapes, materials, mirror, attachment parents and the 6 part
  animations;
- a VFX renderer: GPU points with colour ramps and size curves, auras and lights;
- thumbnails;
- a canvas time chart with crosshair and tooltip;
- a gauge and sparkline;
- the force graph.

**Simulate presets (`src/presets.ts`):** rich hoarder, dodger, pacifist chatterbox, murderer, light fingers and
explorer. They are streamed as explicit `signals` to `POST /admin/simulate` in batches of 3.

**AI move replacement:** an AI upgrade's `boss.move_added` is shown as *upgrade · replaces X*, and the earlier
entry is struck through. This applies to the Director timeline (`boss_move` decisions per boss within 120 s), the
why feed and the stream.

### Server additions (small, additive)

- **`packages/server/src/admin/dashboard.ts` (new):** serves `packages/dashboard/dist` (or
  `LIVEFORGE_DASHBOARD_DIR`) at `/dashboard/*` and redirects `/` to it. It shows a helpful page when the dashboard
  has not been built.
- **`packages/server/src/admin/routes.ts` (new):** `GET /admin/manifest/source` → `{filename, yaml}`, the raw
  manifest for the validator's "Load current".
- **`packages/server/src/http/app.ts`:** three lines that import and mount the two route files above.

### Other shared-file edits

- **Root `package.json`:** `build` also runs `npm run build:web -w @liveforge/dashboard`.
- **Deleted** K0's `packages/dashboard/src/index.ts` stub (replaced by `src/api/admin.ts`).
- **Root files:** `README.md` (rewritten), `CONTRIBUTING.md`, `Dockerfile`, `.dockerignore`,
  `docker-compose.yml`.

### Docs

| File | Contents |
|---|---|
| `README.md` | Pitch, GIF placeholders, features, architecture diagram, Web + Godot quickstart, manifest snippet, links. |
| `docs/README.md` | Index. |
| `docs/quickstart-web.md`, `docs/quickstart-godot.md` | Quickstarts (they follow the K4 SDK and addon API as of K4's worktree). |
| `docs/manifest.md` | Every field and the DSL. |
| `docs/protocol.md` | REST, WS, signals, asks, directives, admin and module routes, curl / Unity C# / Unreal C++ examples. |
| `docs/self-hosting.md` | Node, systemd, Docker, all env vars, providers, costs and budgets, backups. |
| `docs/dashboard.md` | Every panel and a demo-video walkthrough. |
| `docs/recipes/*.md` | 7 recipes plus an index. |
| `docs/media/README.md` | The GIF placeholders. |

## How to try it

```bash
npm install && npm run build
npm run dev                      # open http://localhost:8787/dashboard - key: dev-admin
# no server at all:  npm run dev -w @liveforge/dashboard  ->  http://localhost:5173/?demo
```

Good things to try:

- **Simulate → Dodger:** then open Director to see the boss move, its replacement and the why.
- **Rich hoarder:** then check the why feed (pickpocket) and Rumours.
- **Review & bake → Generate:** then approve, then Export.

## Gaps / concerns

- **Never rendered (no-smoke rule).** Layout, Three.js output, the WS reconnect and the DemoSource are typechecked
  only. The first real run may reveal visual or runtime bugs. Riskiest spots:
  - the force-graph and chart sizing;
  - `ResizeObserver` on hidden tabs;
  - thumbnail WebGL context use (2 contexts);
  - the demo seed path.
- **Admin envelopes are tolerated, not pinned.** For example, `/admin/worlds` has no event counts or players, so
  the client fetches `/admin/players` and joins them.
- **Simulate signals:** presets send explicit `signals`, not the server's `preset` names. The presets use
  Counterforge custom signals (`boss.phase_cleared`, `forge.created`); other manifests reject those per index,
  and the dashboard shows a toast.
- **Review queue scope:** the forge review queue lives in the forge `bakeWorld` (`_bake` by default). The gallery
  panel shows the selected world's `forge.gallery`, so baked items appear in Review but not in the gallery unless
  you pick that world.
- **Unused module routes:** K1, K2 and K3 module routes (traits library, bark pools, world state, quests
  progression, director difficulty) are documented but not yet surfaced as panels.
- **Docs that may drift:** the Godot node property docs (and the Godot snippets) are written against K4's
  in-progress addon. Only `liveforge.gd`, `LiveforgeAsk` and `LiveVFX` existed when written, so nodes such as
  `LiveNPC`, `LiveBoss`, `LiveEquipSlot` and the dock are described from the spec.
- **Docker:** the Dockerfile and compose file are unbuilt (no Docker run allowed). `npm ci` in the image compiles
  `better-sqlite3` with build tools. In this Windows worktree, `npm install` needed `--ignore-scripts` because the
  native build failed on Node 26.
- **Bundle size:** 934 kB (256 kB gzip), mostly Three.js. That is fine for a self-hosted admin tool.
