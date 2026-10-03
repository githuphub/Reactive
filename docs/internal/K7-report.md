# K7 report: village mind (factions) + record/replay cassettes + dashboard panels + Livecraft manifest

**Status:** done. Branch `K7` in worktree `F:/Development/Liveforge-K7`. `npm run typecheck` and `npm run build` pass.
All three example manifests validate with `liveforge-validate`. The only warnings are for `modules.agents` and
`modules.builder`, which are not built-in until K6 merges.
Per the user rules, no tests were written or run, and no server or browser was started. No live API calls were made,
and no key files were read. `npm install` needed `--ignore-scripts` (the better-sqlite3 native build fails on Node 26,
the same as K5).

## What was built

### 1. factions module, the village mind (`packages/server/src/modules/factions/`)

- **Projection `factions.mind`** (world scope, `mind.ts`). There is one `FactionMind` per faction:
  posture, priceMult, trust per player, damage `{count, value, recent[]}`, threats, guards, lastPlan, mood, rumours,
  seen, phase/day, posture history and raids.
  - Trust folds `lf.world.reputation`. This mirrors the World module's reputation instead of keeping a second copy;
    Livecraft feeds its custom signals in through `modules.world.options.reputation`.
  - Damage folds `world.property_damaged`, `world.destroyed` (with an owner) and `block.broken` (with an owner).
    It counts when the owner is a member or the signal is in the `home` zone.
  - Threats come from member kills, thefts, threats and `lf.factions.threat`.
  - Mood moves with gifts, help, trades, quests, repairs, raid-mob kills and rumour sentiment. It has a 10-minute
    half-life.
  - The world clock comes from `world.time`.
- **Council** (`council.ts`). It runs on a 20 s tick, and also within 1.5 s of an important signal (throttled
  per world+faction, with a trailing run).
  - **Rules** pick the posture (calm/wary/hostile/festive). Escalation is immediate; calming down has hysteresis.
  - **Price:** `base[posture] × (1 − 0.3·trust)`, clamped to the faction `priceRange` and the npc clamp.
  - **Guard posts** depend on posture: `home:<owner>` at the most damaged house, and `player:<worst>` when hostile.
  - The rules also write an announcement and a why.
  - On a change the module records `lf.factions.decision`, emits `custom.faction_posture` and `custom.guard_posts`,
    adds a Director timeline entry (`lf.director.decision`, kind `faction_posture`) and a Brain entry.
  - **Haiku council upgrade.** It runs on a posture change with a 30 s cooldown. It may move the posture one step,
    set prices within range, place guards on declared posts and write the announcement. The answer is clamped and
    moderated, then pushed as `stage: "ai"`.
- **Ask `faction.raid_plan`** (`raid.ts`, `habits.ts`).
  - **Habit read:** 20 minutes of signals plus decayed Observer traits. Habits are pillaring, bow_heavy, hiding,
    melee_heavy, kiting and fire.
  - **Counter-table:** the brief's table.
  - **Sizing:** the waves are scaled by size limits, Director aggression and night number.
  - **Captain:** 7 habit taunt templates plus 3 plain ones.
  - **Haiku upgrade:** structured output with the mob enum from `factions[].raid.mobs`, then `clampRaidPlan`, a
    moderated taunt and the same shape. `cacheKey` = player + night + size + top habits + aggression band.
  - Both stages record `lf.factions.raid_plan`, a Director decision (`raid_plan`) and Brain entries
    (threat model → plan → why).
- **Routes:**
  - `GET /v1/m/factions/state?world=&faction=`
  - `POST /v1/m/factions/threat`
  - `GET /admin/m/factions/state`
  - `POST /admin/m/factions/council` (force)
- **Brain:** `brain-shim.ts` calls `ctx.brain(entry)` when K6's core has it and no-ops otherwise.
  `TODO(merge)`: switch to the real `BrainEntry` type.

### 2. Record/replay cassettes (`packages/server/src/providers/cassette.ts`)

- **Env:**
  - `LIVEFORGE_PROVIDER_MODE=live|record|replay` (default live)
  - `LIVEFORGE_CASSETTES` (default `./cassettes`, committed with `.gitkeep`, not gitignored)
  - `LIVEFORGE_CASSETTE_LATENCY_MS` (300)
  - `LIVEFORGE_CASSETTE_FUZZY` (0.6)
- **Client-level Proxy** over `messages.create/stream` and `beta.messages.*`, so K6's `tools()` is covered
  automatically.
- **Key:** sha256 of `{model, system, messages, tools, tool_choice, output_config.format}`. Volatile text is
  normalised first (ISO times, epoch ms, "N min ago"); cache_control is dropped.
- **Replay** matches the exact key, then a loose key (numbers ignored), then a fuzzy match: same
  model/system/tools/schema/roles, best Jaccard over message words. A miss throws `ReplayMissError`, and the rules
  answer stands.
- **Streams** are recorded as the final message and replayed as synthetic deltas (text_delta / input_json_delta).
- **Replay without a key:** `createProviders` builds `ClaudeProvider` in replay mode with no key, so `ctx.llm` is
  non-null. The startup log reads `llm: claude (replay, N cassettes)`.
- **Replayed models** read `replay:<model>`. Runtime `account()` logs them as source `replay` with $0 and 0 tokens,
  and budgets are not charged. `why` strings that print the model show it. Exports `modelBadge()` and
  `isReplayModel()`.
- **Admin:**
  - `GET /admin/cassettes`
  - `POST /admin/cassettes/mode` (503 for live/record without a key)
  - `POST /admin/cassettes/reload`

### 3. Dashboard (`packages/dashboard`)

- **New "Brain" nav group:**
  - **Brain:** a unified feed with source filter chips, a search box, pause, and click-for-data.
  - **Agents:** runs, plan, steps (thought, tool+input, output), model badge and ms.
  - **Builds:** an isometric canvas preview with a build-order slider, the DSL JSON and materials.
- **Factions** now opens with a **Village mind** card per faction: posture, prices, mood, trust bars, guard posts,
  damage, threats, the last decision with its why, history, and raid plans with counters, taunt and why.
- **Top bar:** a LIVE/RECORD/REPLAY badge with cassette count and a runtime mode switch.
- **Brain entries** come from WS `{t:"brain", entry}` (handled before the typed switch) and are derived from events
  (`lf.agents.*`, `lf.builder.planned`, `lf.factions.*`, `lf.director.decision`, `lf.brain*`). They are
  de-duplicated by id and content. History comes from `GET /v1/brain` when K6 has it.
- **`?demo`:** `demo-livecraft.ts` scripts Bram's build run, Oakhollow going wary → calm, and a raid vs a pillaring
  archer, all in replay mode.

### 4. `examples/livecraft.liveforge.yaml`

- **Game:** game id `livecraft`; lore for a bright blocky world and Oakhollow.
- **Personas:** six personas with voices and allowedActions. The Iron Golem is non-verbal (emote, follow, guard,
  hostile).
- **Faction `oakhollow`:** members, home, traits, guards, posts, and raid mobs incl. `baby_zombie`.
- **Actions:** trade, quest_offer, follow, flee, hostile, give, build and guard, plus `emote` (the golem needs it) and
  `call_guards`. There is no steal action.
- **Signals:** block.broken/placed (owner, village), build.pillared, combat.shot_bow, combat.hid, item.crafted,
  item.forged, plus movement.sprinted, item.used and night.survived.
- **Traits:** builder, griefer, pillarer, archer, hider and generous. `rich` is the built-in trait
  (`observer.options.richGold: 64`).
- **Moments:** first_night_survived, griefed_house and built_for_village.
- **Reactions:**
  - **Designer rules:**
    - `repair_mara_house`: a dynamic quest.offer, flavoured.
    - `gather_wheat`
    - `defend_the_village`
    - `statue_for_the_mender`: `custom.statue` to Bram, which drives scenario 3B.
  - **Reaction Library:** 17 of 20 recipes; the three boss recipes are off because there are no bosses.
- **Items** for forge, with an effect enum as tags. **Quests** config, 6 **achievements**, generous **clamps**, and
  rating E.
- **Models:** overrides set `agent.goal`, `builder.plan`, `npc.reply` and every `forge.*` kind to rich.
- **K6 sections:** top-level `agents.tools` (14 tools with JSON schemas) and `builder.palette` (25 block ids). The
  schema strips these silently until K6's schema lands, so validation passes now.

### 5. Docs

- `docs/factions.md` and `docs/record-replay.md` are new.
- `docs/dashboard.md` covers the new panels, the badge and a Livecraft demo flow.
- `docs/manifest.md` covers the faction fields.
- `docs/README.md` has index links.

## Shared-file edits (all additive)

- **`packages/protocol/src`:**
  - new `factions.ts`
  - `index.ts`: export
  - `state.ts`: `PROJECTIONS["factions.mind"]`
  - `asks.ts`: `ASKS["faction.raid_plan"]`
  - `emitSchemas.ts`: 3 top-level schemas
  - regenerated `schema/v1`
- **`packages/manifest/src/schema.ts`:**
  - `FactionSchema` gains `members`, `home`, `traits`, `guards`, `posts` and `raid`
  - `MODULE_IDS` gains `factions`
  - `ModulesSchema` gains `factions` (default **false**, opt-in)
  - regenerated `liveforge.schema.json`
- **`packages/manifest/src/validate.ts`:** members and guards must be personas; warnings for a faction mismatch and
  an unknown home zone.
- **`packages/server`:**
  - `modules/index.ts`: register `factions`; `ASK_OWNERS["faction.raid_plan"]`
  - `core/fallbacks.ts`: a `faction.raid_plan` case
  - `core/runtime.ts`: `account()` handles replay models
  - `providers/claude.ts`: the import plus the client construction line only
  - `providers/index.ts`: replay without a key, the startup log line, and an `export *` of cassette
  - `http/app.ts`: mount `admin/cassettes.ts`
- **`packages/sdk-js`:** `client.ts` gains a `readonly factions` field and an import; `index.ts` gains exports.
- **`packages/dashboard`:** `app.ts`, `main.ts`, `api/types.ts`, `api/admin.ts`, `api/demo.ts`, `panels/factions.ts`
  and `styles.css`.
- **Repo:** `cassettes/.gitkeep`.

## Merge notes for the controller (K6 reconciliation)

- **Shims to replace:**
  - `modules/factions/brain-shim.ts`: use K6's `ctx.brain` and `BrainEntry`.
  - `dashboard/src/api/brain.ts`: the local `BrainEntry`, `AgentRun` and `BuildEntry` types.
  - `dashboard/src/viz/voxel-expand.ts`, imported in `panels/builds.ts` under
    `// TODO(merge): use @liveforge/protocol expandVoxelPlan`.
- **Likely conflicts:**
  - `protocol/state.ts` PROJECTIONS (`agents.runs`)
  - `protocol/asks.ts` ASKS
  - `manifest/schema.ts` MODULE_IDS / ModulesSchema
  - `sdk-js/client.ts` fields
  - `providers/llm.ts`/`claude.ts`: mine is only the construction line plus an import.
  - All of these are additive on both sides; keep both.
- **Brain over WS for the dashboard:** the dashboard subscribes with topics `["events","directives"]`. K6's hub
  should deliver `{t:"brain"}` to admin world subscribers on those topics. If K6 adds a `brain` topic, add it to
  that subscribe call in `api/admin.ts`. Even without it, the Brain panel still fills from events.
- **Brain model badge:** K6 should map the model with `modelBadge()` from `providers/cassette.ts`, so replayed steps
  read `replay`.

## How to try it

```bash
LIVEFORGE_MANIFESTS=examples/livecraft.liveforge.yaml npm run dev     # rules only (no key)
LIVEFORGE_PROVIDER_MODE=replay LIVEFORGE_MANIFESTS=examples/livecraft.liveforge.yaml npm run dev
# signals: world.property_damaged {object, owner: mara, value} x3 -> custom.faction_posture wary + guard_posts
curl -s localhost:8787/v1/ask/faction.raid_plan -H "x-liveforge-key: pk_dev_livecraft" -H "content-type: application/json" \
  -d '{"world":"w1","player":"p1","params":{"night":2}}'
curl -s "localhost:8787/admin/m/factions/state?world=w1" -H "x-liveforge-key: dev-admin"
curl -s localhost:8787/admin/cassettes -H "x-liveforge-key: dev-admin"
# dashboard without a server: npm run dev -w @liveforge/dashboard -> http://localhost:5173/?demo  (Brain / Agents / Builds / Factions)
```

## Gaps and concerns

- **Never run.** Everything is typechecked only. The riskiest spots:
  - the Proxy over the Anthropic SDK client: the SDK version is 0.131 and `messages` is a plain instance field;
  - the synthetic replay stream against `claude.ts`;
  - the trailing-timer evaluation in signal handlers;
  - canvas sizing in Builds.
- **No cassettes ship.** Recording needs a key and live calls, which lanes may not make. The user records one
  session (`LIVEFORGE_PROVIDER_MODE=record`) before the demo. Until then, replay mode is rules-only with "replay"
  plumbing.
- **Cassette keys include the full system prompt.** Prompt changes after recording cause misses, which fall back to
  rules; the fuzzy matcher only helps when system, schema and tools are identical.
- **Persona replies with streaming** are replayed as text chunks of ~32 characters. The sentence splitter
  reassembles them; this is untested.
- **Unrelated quests module re-wording:** `quest.offer` in reaction rules carries full Quest literals with objective
  types `repair` and `survive` (declared in `quests.objectiveTypes`). The quests module may count them only through
  conditions and signals it recognises.
- **Posture is village-wide:** a single griefer makes the whole village wary for everyone, and priceMult is one
  value, not per player. Per-player prices still come from the World module's `priceFor`.
- **`.env.example` was not updated** with the new env vars, to avoid touching env files. They are documented in
  `docs/record-replay.md`; the controller may add them.
