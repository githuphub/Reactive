# Liveforge contracts (v1)

How every lane plugs into the core. Binding for K1–K5 and D1. The design spec is `docs/specs/2026-10-03-liveforge-design.md`; this file is the implementation contract.
If something you need is missing, add it **inside your own folder** and note it in your report. Do not change a shared contract silently. Additive, optional fields are fine. Renames and removals need the controller's OK.

---

## 1. Repo map and ownership

| Path | What | Owner |
|---|---|---|
| `packages/protocol` (`@liveforge/protocol`) | Wire types, zod validators, JSON Schemas (`schema/v1/*.json`), DSL, move grammar, Blueprint/VFX/Variant | **K0** (lanes may add *optional* fields; tell K0) |
| `packages/manifest` (`@liveforge/manifest`) | `liveforge.yaml` schema, validator (line numbers), loader, CLI `liveforge-validate` | **K0** |
| `packages/server` core (`src/*.ts`, `src/core`, `src/store`, `src/http`, `src/providers`, `src/modules/index.ts`) | Hono app, event log, projections, asks engine, WS hub, budgets, cache, providers | **K0** |
| `packages/server/src/modules/observer/**` | Observer | **K1** |
| `packages/server/src/modules/persona/**` | Persona & Voice | **K1** |
| `packages/server/src/modules/world/**` | World reactions | **K2** |
| `packages/server/src/modules/quests/**` | Quests + achievements | **K2** |
| `packages/server/src/modules/director/**` | Director | **K3** |
| `packages/server/src/modules/forge/**` | Forge | **K3** |
| `packages/sdk-js` (`@liveforge/sdk`) | JS/TS client | **K4** |
| `packages/sdk-three` (`@liveforge/three`) | three.js builders + helpers | **K4** |
| `godot/addons/liveforge` | Godot 4 addon + dock + sample | **K4** |
| `packages/dashboard` | Dashboard | **K5** |
| `docs/**` (except this file and `internal/K0-report.md`) | Docs | **K5** |
| `examples/*.liveforge.yaml` | Example manifests | K0. Lanes may add the personas, rules and other entries their demos need. |

Rule: **each lane edits only its own folders.** Module lanes never edit `modules/index.ts` or core. The six modules are already registered.

Commands: `npm install`, `npm run build` (tsc -b + JSON Schema emit), `npm run typecheck`, `npm run dev` (server in watch mode; set `LIVEFORGE_MANIFESTS=examples/counterforge.liveforge.yaml`). No tests until the user says so. Typecheck and build must pass.

## 2. Naming conventions

- **Ids:** lowercase slugs `[a-z0-9_-]` in manifests (`old_tom`, `forge_titan`). Wire ids allow `[A-Za-z0-9_\-.:]`, up to 64 characters.
- **Signal types:** dotted lowercase `ns.verb` (`combat.dodged`, `magic.raise_dead`). The built-in vocabulary and its documented data fields are in `BUILTIN_SIGNALS` (protocol `signals.ts`). Custom types must be declared in manifest `signals`.
- **Internal events** (written by modules with `ctx.record`): `lf.<module>.<what>`, for example `lf.observer.moment` or `lf.world.rumour`. The core writes `lf.directive`.
- **Projection names:** `<module>.<thing>`. The canonical names and their state shapes live in protocol `PROJECTIONS` (see §5).
- **Ask kinds:** `npc.*`, `director.*`, `forge.*`, `quest.offer`, `achievement.check`, `world.reactions` (protocol `ASKS`).
- **Directive kinds:** see `DIRECTIVE_ARGS` in the protocol. Game-specific kinds use `custom.<name>` with free args.
- **Directive targets:** `npc:<id>`, `boss:<id>`, `spawner:<id>`, `player`, `world`, `ui`.
- **Field casing:** camelCase on the wire. The one exception is `MoveSpec.damage_budget`, which keeps the spec's field name.
- **Times:** ms epoch (`ts`). Durations are named in their unit (`seconds`, `expiresInSec`, `timeoutMs`).

## 3. The module plugin interface (`packages/server/src/module.ts`)

```ts
export default defineModule({
  id: "persona",                          // = manifest modules.<id>
  projections: [memoriesProjection],      // folds over the event log (§5)
  signalHandlers: [{ types: ["social.*", "lf.observer.moment"], handle(ctx, ev) { ... } }],
  asks: {
    "npc.bark":  { instant(ctx, p) { ... }, upgrade: async (ctx, p, instant) => ({ result, why }) },
    "npc.reply": { instant, upgrade, cacheKey: () => false },
  },
  ticks: [{ name: "refill-barks", everyMs: 30_000, run(ctx) { ... } }],
  routes: { admin: honoSubApp },          // optional: mounted at /admin/m/persona/*  (public: /v1/m/persona/*)
  init(ctx) { ... },                      // once per game (startup + manifest reload)
});
```

- `instant(ctx, params)` → `{ result, why?, source?: "rules"|"cache"|"bake", final? }`. It must be fast (milliseconds), deterministic where possible, and **never call the LLM**. `params` were already validated with the protocol `ASKS[kind].params` schema, so defaults are applied.
- `upgrade(ctx, params, instantResult)` → `{ result, why? } | null`. It runs in the background after the instant answer was returned, and only when `ctx.llm` exists, budgets allow, and the client did not send `upgrade:false`. The core validates the result against `ASKS[kind].result`. An invalid result is dropped with a log line and the instant answer stands. The core then pushes `{t:"upgrade"}` over WS and stores the result for long-poll. Return `null` to keep the instant answer.
- `cacheKey(params, ctx)`: the core caches upgraded results (exact key plus normalised dedupe). When a later identical ask arrives, the cached AI result is returned as the instant answer with `source:"cache"` and no upgrade. The default key is kind + params + player. Return `false` for anything conversational.
- Errors are handled like this:
  - A throw in `instant` returns the core fallback (§4) and logs the error.
  - A throw in `upgrade` is logged and counted in stats, and the client keeps the instant answer.
  - A throw in a signal handler or tick is logged and never surfaces to the client.
- **Unimplemented kinds** (module disabled, or kind missing from `asks`) answer with the core rules stub in `core/fallbacks.ts`. This keeps every kind answerable from day one.
- **Disabled modules** (manifest `modules.<id>: false`) contribute nothing for that game: no projections, handlers, ticks or asks.

### 3.1 `ctx` API

Every context has the `ModuleContext` fields. Scoped contexts (`AskContext`, `EventContext`, `TickContext`) add `world`, `player` and `session`, and default `emit`/`record` to that scope.

| Member | Purpose |
|---|---|
| `game`, `manifest`, `module`, `options` | Game id, validated manifest (re-read it on every call because admin reload replaces it), your module id, and `manifest.modules.<id>.options`. |
| `log` | Child logger tagged with game and module. |
| `now()` | Server time (ms). |
| `events(query)` | Read this game's event log: `{world?, player?, type? ("combat.*"), after?, since?, limit?, desc?}`. |
| `projections.get(name, {world, player?})` / `.all(name, world)` | Read any module's projection state. Typed for canonical names. |
| `kv` | Module-private persistent key-value store, not rebuilt from the log. Use it for caches such as bark pools and cooldown timestamps. |
| `llm` | `ScopedLlm` or `null`. `json(schema, system, user, {tier, maxTokens, timeoutMs, stream?, task, player})` and `stream(system, user, {tier, onSentence, task, player})`. It maps the tier to a model, checks and charges budgets, and records metrics. **`null` means no key: rules only.** |
| `stt`, `tts` | Provider instances or `null`. Routes use these; modules rarely need them. |
| `jobs.submitMesh(prompt, {world, player, askId, meta})` | Starts a Hyper3D job. Returns `null` unless a key is set **and** manifest `clamps.forge.meshJobs` is on. On completion the core pushes a `forge.ready` directive and a `job` WS message, and records `lf.forge.job`. |
| `budgets.check(player?)` | `{ok}` or `{ok:false, reason}` before you do something expensive. |
| `cache` | `key(kind, material)`, `get`, `set(key, value, {ttlSec})`, plus a `semantic` stub that always returns null. |
| `moderation.check(text, {direction, manifest})` | Keyword moderation by safety rating. Use it on player text in and LLM text out. |
| `emit(draft, scope?)` | Push a directive (§6). Returns the stored `Directive`, or `null` if it was rejected. |
| `record(type, data, scope?)` | Append an internal event. Projections fold it synchronously before `record` returns. |
| `AskContext.chunk(text)` | Inside `upgrade`, streams a sentence to the asking client as WS `{t:"chunk"}`. |
| `AskContext.signal` | Aborted on upgrade timeout or shutdown. Pass it to `ctx.llm` calls. |

### 3.2 LLM usage rules

- Use `ctx.llm.json(schema, system, user, opts)` with a JSON Schema in the **Anthropic structured-output subset**: every object has `additionalProperties:false`, every property is in `required`, and there is no min/max/pattern. Clamp the parsed value yourself, because it is untrusted. Protocol helpers include `clampMove`, `clampBlueprint`, `clampVfx` and `moveJsonSchema(elements)`.
- **Tiers:** `fast` maps to `claude-haiku-4-5` and `rich` to `claude-sonnet-5-5`. You can override them with manifest `models.fast/rich`, env `LIVEFORGE_MODEL_FAST/RICH`, or per task with manifest `models.overrides["npc.reply"] = "rich"` (pass `task`).
- Calls never retry (`maxRetries: 0`). They throw `TimeoutError`, `TruncatedError` (max_tokens or refusal) or `BudgetExceededError`. Catch them and fall back to rules.
- **Streaming replies:** `ctx.llm.json(schema, …, { stream: { field: "text", onSentence: (s) => ctx.chunk(s) } })`. Put `text` **first** in the schema's properties. The provider decodes that field from the partial JSON and emits whole sentences.
- **Prompt hygiene:** inject `manifest.lore.bible`, `lore.tone`, the persona card and `safety` (rating, refusedTopics, inWorldOnly). Keep the system prompt stable so prompt caching works.

## 4. Asks: kinds, owners, two stages

| Kind | Owner | Params → Result (protocol `ASKS`) |
|---|---|---|
| `npc.bark` | K1 persona | `{npc, trigger, context?}` → `{npc, text, emote?, voice?, actions[]}` |
| `npc.reply` | K1 persona | `{npc, text, history?, stream?, context?}` → `{npc, text, emote?, voice?, actions[], mood?, end?}` |
| `director.boss_phase` | K3 | `{boss, phase, hp?, habits?, gear?, existing?, seed?}` → `{boss, phase, moves: BossMovePlan[], aggression, counters, attune?, taunt?}` |
| `director.boss_move` | K3 | `{boss, phase, habits?, existing?, attune?, seed?}` → `{boss, move: MoveSpec, engineMove?}` |
| `director.encounter` | K3 | `{units[], zone?, habits?}` → `{assignments[], modifiers[], aggression}` |
| `director.pacing` | K3 | `{intensity?, enemiesAlive?, playerHp?, …}` → `{tension, action, directives[], aggression?}` |
| `forge.item` / `armour_set` / `look` / `vfx` / `creature` / `npc_look` / `prop` / `loot` | K3 | → `ForgedItem` / set / `Variant` / `VfxRecipe` / `Creature` / variant+accessories / `Prop` / `ForgedItem[]` |
| `quest.offer` | K2 quests | `{giver?, zone?, context?}` → `{quest: Quest \| null}` |
| `achievement.check` | K2 quests | `{recent?}` → `{unlocked: Achievement[]}` |
| `world.reactions` | K2 world | `{zone?, npcs?}` → `{rumours[], directives[], attitudes}` |

Wire format: `POST /v1/ask/:kind` with `{id?, world, player, session?, params, upgrade?}`. The response is `AskResponse` `{id, kind, stage:"instant", result, source, why?, upgrade:"pending"|"none", ms, ts}`. The upgrade arrives as WS `{t:"upgrade", response:{…stage:"upgrade", source:"ai"}}`, or by long-poll `GET /v1/upgrades/:id?wait=25`, which returns 200 with the response, 204 while pending, or 404 when the id is unknown or expired.

The core does these things for every ask:
1. Validates params.
2. Runs moderation on `npc.reply.text`.
3. Checks the cache.
4. Calls `instant`.
5. Schedules `upgrade`.
6. Pushes the upgrade, caches it, and writes `ask_log` metrics.

Modules never touch HTTP.

## 5. Event log and projections

- **Everything is an event.** Signals from SDKs are stored with `origin:"sdk"`. Module facts are recorded with `ctx.record("lf.<module>.<what>", data)` and `origin:"module"`. Directives are stored as `lf.directive` with the `Directive` as data.
- **A projection** (`module.ts` `Projection`) is `{name, scope: "world"|"player", version?, types?, init(key, manifest), apply(state, event, env)}`.
  - `apply` **must be deterministic**: no LLM, no `Date.now()` (use `event.ts`), no randomness without a seed taken from the event.
  - LLM-generated state such as profile text, rumour wording or memory summaries is first recorded as an event (`lf.observer.profile`, `lf.world.rumour`, …) and then folded.
- The core applies projections synchronously on append, persists checkpoints every 2 s, and rebuilds from the log on startup when a projection's `version` changes, on `POST /admin/rebuild`, and on snapshot import.
- **Canonical projections.** Their state shapes are zod schemas in protocol `state.ts`, and the dashboard reads them by these names:

| Name | Scope | Owner | Shape |
|---|---|---|---|
| `observer.player_model` | player | K1 | `PlayerModel` (traits {score, evidence, updatedAt}, moments, profile, stats, eventCount) |
| `persona.memories` | player | K1 | `PersonaMemories` (npcs → `NpcMemory` {attitude, entries, summary}) |
| `world.rumours` | world | K2 | `RumourState` (rumours, spread edges) |
| `world.factions` | world | K2 | `FactionState` (reputation[faction][player], relationships) |
| `quests.log` | player | K2 | `QuestLog` (offered, active, completed, failed, achievements) |
| `director.state` | world | K3 | `DirectorState` (aggression, mode, tension curve, bosses, timeline of decisions with `why`) |
| `forge.gallery` | world | K3 | `ForgeGallery` (entries with review status) |
| `core.directives` | world | K0 | `DirectiveLog` (last 200 directives) |

- **Cross-module data flows through events and projections.**
  - The Observer records `lf.observer.moment` with `{moment: Moment}`. The core also pushes it as a `moment` directive when the Observer emits one.
  - World, Quests and Persona subscribe to those events with `signalHandlers`.
  - Use `ctx.projections.get("observer.player_model", {world, player})` for traits and stats.
- **Recommended internal events.** Owners may add more.
  - **Observer:** `lf.observer.moment {moment}` and `lf.observer.profile {text, eventCount}`
  - **Persona:** `lf.persona.memory {npc, entry: MemoryEntry}`, `lf.persona.turn {npc, said, reply, actions}` and `lf.persona.attitude {npc, delta}`
  - **World:** `lf.world.rumour {rumour}`, `lf.world.rumour_spread {rumourId, from, to, content}` and `lf.world.reputation {faction, delta, reason}`
  - **Director:** `lf.director.decision {decision: DirectorDecision}`
  - **Forge:** `lf.forge.created {askKind, askId, result, source}` and `lf.forge.job {jobId, state, url?}` (the latter written by the core)
  - **Quests:** `lf.quests.offered {quest}`, `lf.quests.progress {questId, objectiveId, progress}` and `lf.quests.achievement {achievement}`

## 6. Directives

`ctx.emit({kind, target, args, why}, {world, player?})` validates the directive before pushing it:
- The kind must be a known protocol kind or `custom.*`, and the args must match `DIRECTIVE_ARGS[kind]`.
- `npc.action`: the action must be declared in manifest `actions` with `by` including `npc`, and be in the persona's `allowedActions` if it has any.
- `why` is required, at most 200 characters. Keep it short and human, for example "dodges left 70% → fan biased left".

The core stamps `id`, `ts`, `world`, `player` and `source`, records `lf.directive`, and pushes WS `{t:"directive", directive}` to subscribers. With `player: null` it goes to everyone in the world. The rules:
- **Only actions in the manifest action schema are ever emitted.**
- Rejected drafts return `null` and log a warning.
- Manifest `reactions[].then` drafts go through the same path. Owner: K2 world evaluates the `when` DSL.

## 7. Trait-rule DSL (protocol `dsl.ts`)

Used by manifest `traits`, `moments`, `reactions[].when`, `achievements[].condition`, `progression.unlocks[].condition` and `objective.dynamic.condition`. Example: `count(magic.raise_dead, 10m) > 10 & trait(rich) > 0.6`.
- `parseDsl` / `checkDsl` / `compileDsl(src)(env)` / `dslSignalRefs`.
- Functions: `count, sum, avg, max, rate, last, since, distinct, trait, stat, moment, rep, attitude, has, min2, max2`. They are documented in `DSL_FUNCTIONS`.
- **K1 (Observer) owns the canonical `DslEnv`** over its windows and exports a helper from its folder, for example `modules/observer/dsl-env.ts` → `makeDslEnv(ctx, world, player)`. K2 imports it for reactions and achievements. Until it exists, K2 can stub it locally.
- Bare identifiers resolve through `env.ident`: a trait score, else a stat. Numbers are truthy at ≥ 0.5.

## 8. Content formats (protocol)

- **Blueprint v1** (`blueprint.ts`): engine-neutral primitive parts `{role, shape, size, offset, rotation, material | materialName, anim?, mirror?, parent?}`, plus `palette`, `materials`, `attachments` (`grip` = hand socket), `lod`, `trail`/`particles` (quick FX, Counterforge-compatible) and `vfx[]`.
  - Axes: metres, +Y up, held items run grip → tip along +Y with the grip at the origin.
  - Shape fill rules: `SHAPE_NOTES`.
  - Always pass untrusted input through `clampBlueprint(raw, limits)`. It also accepts Counterforge `ItemBlueprint`.
- **VFX recipe v1** (`vfx.ts`): emitters `{shape, rate, burst, maxParticles, lifetime, velocity{dir, speed, spread}, gravity, colorRamp, sizeCurve, sprite, blend}`, plus `trails`, `auras`, `lights`, `attach`. Clamp with `clampVfx`.
- **Variant v1** (`variant.ts`): `baseAsset` plus `materialSwaps`, `recolour`, `decals`, `scale`, `partToggles`, `attachments` (blueprints) and `vfx`.
- **Move grammar** (`moves.ts`, ported from Counterforge): `MoveSpec {name, taunt, shape, element, pattern, count, telegraph, speed, size, damage_budget, status, bias, engine?}`.
  - Use `clampMove(raw, {elements, damageScale, engineMoves})`, `composeMove(req)` (the keyless rules composer, which returns the move plus the habit it punishes), `cleanHabits`, `moveJsonSchema(elements)`, `MOVE_BUDGET` and `MOVE_LIMITS`.
  - An engine-native move is `engine: {moveId, params}` with ids from manifest `moves.engine`.
- **ForgedItem, Quest, Achievement, Rumour, Moment, NpcAction, VoiceStyle** are in `content.ts`.

## 9. HTTP API (server)

Auth uses a publishable SDK key per game (`Authorization: Bearer pk_…` or `x-liveforge-key`) or the admin key. Admin routes take `x-liveforge-game` or `?game=` (default: the first game). In dev mode (`LIVEFORGE_DEV`, the default outside production) with no keys configured, `pk_dev_<gameId>` and `dev-admin` are accepted. All errors use the shape `{error:{code, message, details?}}`.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness check plus protocol version. No auth. |
| `GET /v1/config` | `PublicConfig`: personas, bosses, actions, custom signals, elements, enabled modules, ask and directive kinds. |
| `POST /v1/signals` | `{signals: Signal[]}` → `SignalBatchResult`. Undeclared custom types are rejected per index. |
| `POST /v1/ask/:kind` | Ask (§4). |
| `GET /v1/upgrades/:id?wait=25` | Long-poll fallback. |
| `GET /v1/ws?key=…` | WebSocket (§10). |
| `POST /v1/stt?language=en` | Multipart field `audio`, or a raw `audio/*` body → `SttResponse`. |
| `GET /v1/forge/jobs/:id` | `ForgeJob`. |
| `GET /v1/assets/:file` | Generated GLBs. |
| `GET /v1/snapshot?world=` / `POST /v1/snapshot` | Export or import a world (`Snapshot`). |
| `/v1/m/<module>/*` | Module public routes. |
| `GET /admin/games` | Games, enabled modules and world counts. |
| `GET /admin/manifest`, `POST /admin/manifest/validate` (YAML or JSON body → issues with line numbers), `POST /admin/manifest/reload` | Manifest. |
| `GET /admin/worlds`, `GET /admin/players?world=` | Tenancy. |
| `GET /admin/events?world&player&type&after&limit&desc` | `EventPage`. |
| `GET /admin/projections` (names and scopes), `GET /admin/projections/:name?world&player` | Projection states. A player-scope projection without `player` returns `{players: {id: state}}`. |
| `POST /admin/rebuild {world?}` | Rebuild projections from the log. |
| `GET /admin/stats` | `StatsResponse`: per-module asks, cache hits, p50/p95, tokens and $, budgets, WS connections. |
| `GET /admin/jobs` | Forge jobs. |
| `GET /admin/review?status=`, `POST /admin/review` (enqueue), `POST /admin/review/:id {status, note?}`, `GET /admin/bake` (`BakePack` from approved items) | Bake / review queue. |
| `GET /admin/simulate/presets`, `POST /admin/simulate` (`SimulateRequest`) | "Simulate player" presets. |
| `/admin/m/<module>/*` | Module admin routes. |

## 10. WebSocket protocol (`ws.ts`)

Connect to `GET /v1/ws?key=<pk or admin>[&game=<id>][&world=&player=]`. Passing `world` in the query auto-subscribes. Frames are JSON, one message per frame, discriminated by `t`.
- **Client → server:** `subscribe {world, player?, topics?}`, `unsubscribe`, `ping`. Topics are `directives`, `upgrades`, `chunks` and `jobs` by default. `events` is the live firehose and requires the admin key.
- **Server → client:** `welcome`, `subscribed`, `directive`, `upgrade`, `chunk {id, seq, text, done}`, `event` (admin), `job`, `pong`, `error`.
- Delivery rules:
  - Upgrades, chunks and jobs go only to sockets subscribed with that world **and** player.
  - A directive with `player:null` goes to every socket subscribed to that world.
- The server pings every 30 s. Clients should reconnect with backoff and re-subscribe.

## 11. SDK contract (K4)

- Types and validators come from `@liveforge/protocol`. Do not redefine wire types.
- **The JS SDK** (`@liveforge/sdk`) ships a typed client stub. K4 completes it with: batching (flush every 250 ms or 50 signals), retry with backoff, upgrade swap (resolve `instant`, then fire `onUpgrade`), WS reconnect, long-poll fallback, fallback cache plus bake packs (`BakePack`), and snapshots.
- **The Godot addon** mirrors the same API: `signal()`, `ask()` with the Godot signals `answered` and `upgraded`, and `directive`. For Godot, read the JSON Schemas in `packages/protocol/schema/v1/` and `index.json`.
- Builders (three.js and Godot) implement Blueprint, VFX and Variant per §8 conventions, including `SHAPE_NOTES`.

## 12. Dashboard contract (K5)

- Read-only use of the `/admin/*` routes in §9, plus the admin WS (`topics:["events"]`) for the live signal stream.
- The validator: `POST /admin/manifest/validate`, or import `parseManifest` from `@liveforge/manifest` directly. It is browser-safe.
- Cost, latency and cache meters come from `GET /admin/stats`.
- The Director timeline comes from projection `director.state` (`timeline[].why`). The rumour graph comes from `world.rumours.spread`.
- The dashboard is a separate static app. Point it at a server URL with the admin key.

## 13. Environment

See `.env.example`. Provider keys exist **only** in server env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `HYPER3D_API_KEY`, and whisper.cpp paths. Without keys, everything still works on rules: instant answers, with no upgrades.
