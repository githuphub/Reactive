# K0 report: Core

**Status:** done. `npm run build` passes, and so does `npm run typecheck` (both are `tsc -b`, TypeScript 7, strict ESM); build also emits the JSON Schemas. Both example manifests validate with `liveforge-validate`.
Per the user rule, no tests were written or run, and the server was **never started**. No live API calls were made. Only `.env.example` exists; no key files were read.

## Commits (branch `main`)

1. `786d8ed` chore: monorepo scaffold + protocol v1
2. `5144946` feat(manifest): schema, validator with line numbers, loader, CLI + example manifests
3. `5ef9d93` feat(server): module plugin interface, ctx API, module stubs, providers + docs/CONTRACTS.md (the priority commit; K1–K3 can start from here)
4. `074e28d` feat(server): runtime, two-stage ask engine, projections, WS hub, jobs, budgets, HTTP + admin API
5. `72d74a8` feat: SDK client stub, three/dashboard/Godot skeletons, README, .env.example
6. `995c7ca` fix(server): upgrade abort bookkeeping; admin WS spectators
7. `05387fd` docs: docs index + pitch stub
8. (this report)

## What was built

### Monorepo
- npm workspaces: `protocol`, `manifest`, `server`, `sdk-js`, `sdk-three`, `dashboard`.
- `tsconfig.base.json` uses NodeNext and project references.
- Root scripts: `build`, `typecheck`, `dev` (builds protocol + manifest, then runs `tsx watch` on the server), `start`.
- Also added: LICENSE (MIT, 2026 the Liveforge authors), README, `.env.example`, `.gitattributes` (LF).
- `godot/addons/liveforge` has `plugin.cfg`, `plugin.gd` and a `liveforge.gd` autoload stub.

### `@liveforge/protocol` (liveforge-protocol/1)
Every type is a zod schema plus its inferred TS type. The JSON Schemas are emitted to `packages/protocol/schema/v1/` (87 files plus `index.json`, with the vocabulary for Godot).
- **Signals:**
  - `Signal`, `SignalBatch` and `SignalBatchResult`.
  - The built-in vocabulary `BUILTIN_SIGNALS` covers every spec §2.1 type, with documented data fields.
- **Asks:**
  - `ASKS` defines params and result schemas for all 17 kinds: the spec's kinds plus `director.boss_move`.
  - Request/response types are `AskRequest` and `AskResponse {id, kind, stage, result, source, why, upgrade, ms, ts}`.
- **Directives:**
  - `Directive {id, kind, target, args, why, ts, world, player, source}` plus `DIRECTIVE_ARGS` for 16 kinds and `custom.*`.
  - `validateDirectiveArgs` checks args per kind.
- **WS envelope:** `subscribe`, `unsubscribe` and `ping` from the client; `welcome`, `subscribed`, `directive`, `upgrade`, `chunk`, `event`, `job`, `pong` and `error` from the server.
- **HTTP shapes:** `ErrorBody` and error codes, `SttResponse`, `ForgeJob`, `Snapshot`, `PublicConfig`, `StatsResponse`, `ReviewItem` and `BakePack`.
- **Blueprint v1:**
  - Generalised from Counterforge `ItemBlueprint`, adding materials (inline or named), attachment points, palette, LOD hint, kind, `vfx[]` and extra roles.
  - `clampBlueprint` also accepts Counterforge parts. `SHAPE_NOTES` documents how each primitive fills its size.
- **VFX recipe v1 and Variant v1:** VFX has emitters, trails, auras and lights, with `clampVfx`. Variant covers material swaps, recolour, decals, scale, toggles and attachments.
- **Move grammar:**
  - Ported from Counterforge: `MoveSpec` (with `damage_budget`, as the spec names it), `clampMove`, `composeMove`, `cleanHabits`, `MOVE_BUDGET` and `moveJsonSchema(elements)`.
  - Elements come from the manifest, there is an `engine {moveId, params}` mapping, and `damageScale`.
- **Content and state:**
  - `ForgedItem`, `Quest`, `Achievement`, `Rumour`, `Moment`, `NpcAction` and `VoiceStyle`.
  - Projection state shapes for the 8 canonical projections are in `PROJECTIONS`, which the dashboard builds against.
- **Trait-rule DSL:** `parseDsl`, `checkDsl`, `evalDsl`, `compileDsl` and `dslSignalRefs`, plus the function catalogue `DSL_FUNCTIONS`.

### `@liveforge/manifest`
- The zod schema covers all of spec §2.5: game, lore, elements, zones, personas, factions, relationships, traits, moments, signals, actions, reactions, items, quests, moves, bosses, progression, achievements, clamps, safety, budgets, models and modules.
- `parseManifest` (YAML) reports `file:line:col path: message`. It runs cross-checks:
  - unknown factions, personas, actions and engine moves
  - DSL syntax and function names
  - directive kinds in reactions
  - duplicate ids
- Helpers: `moduleEnabled`, `moduleOptions`, `personaById`, `actionsFor`, `signalAllowed`.
- Node loader `@liveforge/manifest/node` (`loadManifest`), CLI `liveforge-validate`, and an editor JSON Schema in `schema/liveforge.schema.json`.
- `examples/counterforge.liveforge.yaml`: a forge-fantasy academy with Vale, porter Pell, librarian Marrow and pickpocket Kit; the Forge Titan and the Hollow Professor; 18 weapon families; actions and reactions.
- `examples/godot-village.liveforge.yaml`: innkeeper, guard, merchant and thief, plus a training-dummy boss.

### `@liveforge/server`
- Hono app (`http/app.ts`, `http/admin.ts`) with every spec §4.2 route, plus `/v1/config`, `/v1/upgrades/:id` (long-poll), `/v1/assets/:file`, module routes under `/v1/m/<id>` and `/admin/m/<id>`, and the full admin API in CONTRACTS §9.
- **Auth:**
  - A publishable key per game (`LIVEFORGE_SDK_KEYS`) and an admin key.
  - Dev mode accepts `pk_dev_<gameId>` and `dev-admin`.
  - A per-key fixed-window rate limit.
- **SQLite store** (better-sqlite3, WAL; works on the local Node 26):
  - Event log, projection state and checkpoints.
  - Worlds and players (tenancy), namespaced kv, cache, forge jobs, `ask_log` metrics, daily usage, and the review queue.
- **Projection framework:**
  - Folds run synchronously on append and keep state in memory, flushed every 2 s.
  - On startup it restores from the checkpoint when the projection signature (names and versions) matches, and otherwise rebuilds from the log.
  - Rebuild works per game or per world. Snapshot export/import replaces a world's events and then rebuilds.
- **Two-stage ask engine:**
  - Steps: validate params → moderation on `npc.reply` → cache hit (`source: "cache"`) → module `instant`, or the core rules fallback for every kind → schema-validated result → background `upgrade`.
  - The upgrade is gated on LLM present, budget OK and the client not opting out. It has a timeout and abort, optional sentence `chunk` streaming, and is schema-validated before it is pushed over WS and the long-poll and cached.
  - When the upgrade fails, the client still gets a final `upgrade` echoing the instant result with a non-"ai" source.
- **Directive emission:** validates kind and args, checks the manifest action schema, persona `allowedActions` and arg types, and clamps args. It records `lf.directive` and pushes over WS.
- **WS hub:** subscribe per world and player with topics, an admin firehose (`events`), and a 30 s ping.
- **Other core pieces:**
  - **Budgets:** per-game and per-player tokens/min and $/day.
  - **Cache:** exact plus normalised key, SQLite plus LRU, and a semantic-cache stub.
  - **Model tiering:** manifest, then env, then a per-task override.
  - **Moderation:** a `Moderator` interface with a `KeywordModerator` based on the E/T/M rating plus `safety.blocked`.
  - **Forge job runner:** Hyper3D jobs, GLBs saved to `data/assets`, then `forge.ready` plus `lf.forge.job`.
  - **Metrics** for `/admin/stats`, simulate presets, and the review/bake queue with `BakePack` export.
- **Module plugin interface** (`module.ts`): `LiveforgeModule {id, projections, signalHandlers, asks{instant, upgrade, cacheKey}, ticks, routes, init}`.
  - The ctx API includes manifest, log, events, projections, kv, llm, stt, tts, jobs, budgets, cache, moderation, emit and record. Asks also get `chunk` and `signal`.
  - Six registered stubs live in `modules/<id>/index.ts`, and `modules/index.ts` holds the registry and the `ASK_OWNERS` map.
- **Providers:**
  - `LlmProvider` has `json(schema, system, user, {tier, maxTokens, timeoutMs, stream?})` and `stream(...)` with sentence chunks.
  - `ClaudeProvider` is ported from Counterforge `llm.ts`: output_config or strict_tool, a hard timeout with abort, `maxRetries: 0`, and the max_tokens/refusal truncation guard. On top of that it adds streamed JSON-field extraction for replies, per-model knobs, and a price table.
  - STT: `OpenAiWhisperStt` (fetch + multipart) and `WhisperCppStt` (spawned binary, ffmpeg conversion).
  - 3D: `Hyper3DProvider`, ported verbatim from Counterforge `hyper3d.ts`.
  - TTS: interface only.

### SDK, dashboard and Godot skeletons
- `@liveforge/sdk` ships a working typed client stub: `connect`, batched `signal`, `ask` returning `{instant, upgrade, onChunk}` with a long-poll fallback, typed `on(kind)`, and `close`.
- `@liveforge/three` has stub signatures that throw "not implemented (K4)".
- `dashboard` has a tiny typed admin client.
- The Godot addon is a skeleton.

## Contracts summary
See `docs/CONTRACTS.md`. In short:
- Each lane edits only its own folder.
- Modules plug in through `defineModule({...})` in `packages/server/src/modules/<id>/index.ts`.
- Unimplemented ask kinds answer from `core/fallbacks.ts`.
- Projections are deterministic folds. LLM output is first recorded with `ctx.record("lf.<module>.<what>")`.
- The canonical projection names and shapes are in protocol `PROJECTIONS`.
- Directives always go through `ctx.emit`, which validates them against the manifest.
- The LLM is reached only through `ctx.llm`, which may be null, so modules must keep working on rules.
- K1 owns the canonical DSL environment (`modules/observer/dsl-env.ts`), and K2 imports it.

## Gaps and concerns
- **Not run.** Per the no-smoke rule, the server was never started. HTTP, WS, SQLite, projections and the provider code are typechecked only. The first lane to run `npm run dev` is the first runtime check. The most likely problem spots are:
  - the hono/node-server wiring for WS upgrades
  - the projection restore path
- **Claude request knobs are unverified live.**
  - Refusal fallbacks (`server-side-fallback-2026-07-01`, `fallbacks:"default"`) are on by default for sonnet-5-5 and opus-5. If the API rejects them, they disable themselves for the process.
  - sonnet-5-5 uses `thinking: {type: "between_tools"}` and `effort: "low"`.
  - Env flags exist to change these (`LIVEFORGE_REFUSAL_FALLBACK=0`, `LIVEFORGE_LLM_EFFORT`, `LIVEFORGE_LLM_STRUCTURED_MODE=strict_tool`).
- **Hyper3D `quality_override`** is still marked UNVERIFIED, carried over from Counterforge.
- **whisper.cpp** needs WAV input, or `FFMPEG_BIN` to convert other formats.
- **Workers compatibility:** the core uses node-only pieces (better-sqlite3, ws, node:crypto/fs), so it is not Workers-compatible as the spec hoped. A Workers port needs a D1/Durable Objects store adapter.
- **Moderated `npc.reply` input** returns HTTP 422 `moderated` rather than an in-character refusal. K1 may want to handle refusals inside persona instead; that would be a core change, so ask K0.
- **In-memory state:**
  - Pending upgrades for long-poll and the rate limiter are in memory and lost on restart.
  - Projection state is fully in memory, which is fine at hackathon scale.
- **Additions beyond the spec** (all additive):
  - `director.boss_move` ask kind
  - directive kinds `boss.adapt`, `quest.update`, `loot.drop`, `difficulty.set` and `world.reaction`
  - routes `/v1/config`, `/v1/upgrades/:id` and `/v1/assets/:file`
  - `MoveSpec.damage_budget` (Counterforge `damage` is still accepted by `clampMove`)
- **Counterforge element casing:** Counterforge uses capitalised `Physical`, `Fire` and so on; Liveforge manifests use lowercase. `clampMove` matches case-insensitively, but D1 must map other enums itself.
- **Semantic cache** is a stub, and the keyword moderation lists are minimal.
- **Merge risk with K4 and K5:** they started in worktrees before `sdk-js/src/index.ts` and `dashboard/src/index.ts` existed on main. Merges may conflict there; their versions should win.
