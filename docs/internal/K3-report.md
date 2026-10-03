# K3 report: Director + Forge

**Status:** done. `npm run build` and `npm run typecheck` pass on branch `K3` (merged with `main` at `8169acd`, which includes K1 and K2). Both example manifests validate with `liveforge-validate`.
Per the user rule, no tests were written or run, and the server was never started. No live API calls were made, and no key files were read.

## What was built

### Forge (`packages/server/src/modules/forge/`)
This is Counterforge's pipeline, generalised. It ports `procedural`, `archetypes`, `keywords`, `improvised`, `summon`, the forge parts of `rules`, `validate` and `prompts`, and `interpret`'s compact-style approach. The forge no longer hard-codes families or classes: it is driven by the manifest `items` schema, and falls back to Counterforge-shaped defaults when a game declares none.

**Asks:** all eight kinds — `forge.item`, `forge.armour_set`, `forge.look`, `forge.vfx`, `forge.creature`, `forge.npc_look`, `forge.prop` and `forge.loot`.
- **Instant (rules):** keyword plus procedural generation.
  - Element detection works over the manifest elements and their synonyms.
  - The archetype is picked with the head-noun rule, restricted to the manifest's families. Every family maps onto one of the 18 library templates; for example `katana` maps to sword and `pistol` to gun.
  - A prompt that names an everyday thing ("a train") becomes an improvised weapon.
  - Armour slots are detected from the prompt or taken from the `slot` param.
  - Stats come from `items.stats`, kept within the rarity budget.
  - Creativity rules apply: raw-power requests stay common and plain.
  - Manifest tags are picked from cues in the prompt.
  - Outputs are Blueprint v1 (attachment points for the grip, tip and `vfx_core` socket, an LOD hint, materials), Variant v1, VFX recipe v1, Creature and Prop.
- **Upgrade (AI):** one structured call per ask. The schema is generated from the manifest.
  - The LLM writes a compact style or compact shape, never a whole blueprint.
  - Everything is clamped: `clampStats` enforces the budget, and creativity is capped by `items.creativity.max` and the raw-power rule.
  - Guards keep models usable: grip guard and auto-handle for held items, ground guard for creatures and props, centre guard for worn pieces.
  - Names and flavour text go through output moderation.
- **Fizzle rule:** a prompt blocked by moderation forges a harmless "Fizzled Slag" item as a final answer, instead of returning an error.
- **Rate limit:** `clamps.forge.maxPerMinPerPlayer` applies. Over the limit, the player gets a rules-only final answer.
- **Hyper3D:** when an ask has `mesh: true`, the manifest has `clamps.forge.meshJobs`, and a key is set, the forge calls `ctx.jobs.submitMesh`.
  - The instant answer waits up to `meshWaitMs` for the job id. The blueprint stands in until the mesh is ready.
  - The core pushes `forge.ready` with the GLB url.
  - `GET /v1/m/forge/mesh/:jobId` is the asset proxy: it answers 302 to the stored GLB, 202 `{state}` while generating, 410 on failure and 404 for an unknown id.
- **Projection `forge.gallery`:**
  - It folds `lf.forge.created`, `lf.forge.review` and `lf.forge.job`, and a late mesh is matched to its entry by `askId`.
  - Entries carry an extra optional `key`: the prompt, used for bake-pack lookup.
- **Bake mode and review queue** (admin), all event-sourced so the dashboard reads the same projection:
  - `POST /admin/m/forge/bake {kind, count?, prompts?, params?, world?, ai?, seed?}` generates a catalogue. Without prompts, it cycles families × elements, or creature and prop nouns. Results are recorded as `pending`; with `ai: true` an AI pass runs in the background, within budgets.
  - `GET /admin/m/forge/review?world=&status=&kind=` lists entries.
  - `POST /admin/m/forge/review/:id {status, world?, note?}` approves or rejects one.
  - `GET /admin/m/forge/pack?world=&kinds=` exports a `BakePack` of approved entries, plus `assets[]`, the GLB urls the pack references.
- **Library data:**
  - `library/archetypes.ts` holds about 130 Counterforge archetypes as data.
  - `library/objects.ts` holds about 40 everyday things, creature behaviour models and a generic seeded fallback.
  - `library/armour.ts` holds the slot templates.
  - `elements.ts` keeps Counterforge's four palettes, adds 10 more, and generates a palette from a hash for any other element name.
- **Options:** `modules.forge.options` takes `creatureStats`, `creatureBehaviours`, `meshWaitMs`, `bakeWorld`, `maxBake` and `lootRarityBoost`. They are documented in `env.ts`.

### Director (`packages/server/src/modules/director/`)
- **`director.boss_phase` and `director.boss_move`:**
  - The rules path uses the protocol's `composeMove`, the Counterforge rules composer, seeded per boss, phase and player. `moves.shapes` restricts the shapes, and a move outside them is mapped to the nearest allowed shape.
  - Each move is mapped onto an engine move from the manifest's `moves.engine`: the boss's own move with the same shape first, otherwise any engine move with that shape. Params are fitted to the designer bounds by param name (count, radius, speed, telegraph, damage, duration).
  - The phase plan tunes the boss's engine moves by phase and aggression, and weights them by which habits they punish. The invented-move rotation is capped at `maxInvented`.
  - Counters come from `boss.counters`, intersected with the player's traits and habit labels, gear tags and favourite element.
  - Attune is the player's favourite element.
  - The taunt is the move's habit taunt. The AI upgrade rewrites it in the boss persona's voice (lore, tone, persona card and safety are in a per-boss system prompt that stays stable).
  - Directives: `boss.move_added` and `boss.adapt`.
  - The AI move replaces the move the rules path invented, both in the rotation and in the plan.
- **Player read (`habits.ts`)** merges three sources:
  1. The player's combat and movement signals from the last 2 minutes.
  2. K1 Observer traits, decayed through `observer/view.traitAt`, plus equipped gear tags from `observer/view.gearTags`.
  3. Explicit `habits` from the ask.
- **`director.encounter`:**
  - Each unit's role is read from its type id (ranged, tank, skirmisher, support or melee).
  - Tactics follow the role and the player's strongest habit, chosen from `options.tactics`.
  - Counter elite modifiers come from `options.eliteModifiers` (each `{id, counters[]}`), scored against the player read.
  - The AI upgrade reassigns tactics and modifiers and is clamped to the unit ids and both lists.
- **`director.pacing`** is rules-only and final, because it is a real-time loop.
  - Tension follows intensity with a fast attack and a slow decay, from 30 s of combat signals or the game's own `intensity`.
  - It cycles build → peak → relax. Build pushes `spawn.wave` from `options.spawnTable`, within `maxSpawnPerMin` and `maxWaveSize`, and escalates with an elite when the player is cruising. Relax pushes `pacing.breather` (scaled within `breatherSec`) and a `loot.drop` (forge loot rules) within `lootPerMin`.
  - Tension samples are recorded to `director.state`.
- **Difficulty:** aggression stays within `clamps.difficulty` and moves at most `maxStep`.
  - **hidden** adapts every 20 s or more from deaths, near-deaths and kills over 5 minutes.
  - **assist** pins aggression at the minimum and announces it.
  - **off** keeps aggression at `fixedAggression` or the midpoint.
  - Every change emits a `difficulty.set` directive with a why.
  - `POST /v1/m/director/assist {world, player, on}` is the player's toggle, and `POST /admin/m/director/difficulty {world, mode?, aggression?, why?}` is the designer's.
- **Tick `pacing`** (every 5 s): it samples tension for active players and adapts difficulty. With `options.autoPacing: true` it also pushes pacing directives on its own.
- **Projection `director.state`:** aggression, mode, the tension curve, the per-boss rotation, and a timeline in which every decision carries a `why`.
- **Options:** `modules.director.options` takes `tactics`, `eliteModifiers`, `spawnTable`, `autoPacing`, `peakSec`, `fixedAggression` and `inventPerPhase`. They are documented in `options.ts`.

## Shared-file edits (small, additive)
- `examples/counterforge.liveforge.yaml`:
  - Added `items.assets`: `student_robes` and `titan_plating`.
  - `modules.director` and `modules.forge` changed from `true` to `{enabled: true, options: {...}}`. The options hold Counterforge data: elite modifiers, spawn tables, creature behaviours and creature stats.
- No changes to the protocol, the manifest schema or the core.

## How to try it (dev mode, no keys = rules only)
```
LIVEFORGE_MANIFESTS=examples/counterforge.liveforge.yaml npm run dev
curl -s localhost:8787/v1/ask/forge.item -H "x-liveforge-key: pk_dev_counterforge" -H "content-type: application/json" \
  -d '{"world":"w1","player":"p1","params":{"prompt":"a frost harpoon on a chain"}}'
curl -s localhost:8787/v1/ask/director.boss_phase -H "x-liveforge-key: pk_dev_counterforge" -H "content-type: application/json" \
  -d '{"world":"w1","player":"p1","params":{"boss":"forge_titan","phase":2,"habits":{"dodgeLeft":0.85,"dodgeRate":9}}}'
curl -s localhost:8787/admin/m/forge/bake -H "x-liveforge-key: dev-admin" -H "content-type: application/json" -d '{"kind":"item","count":12}'
curl -s "localhost:8787/admin/m/forge/review?status=pending" -H "x-liveforge-key: dev-admin"
```

## Gaps and concerns
- **Never run.** Everything is typechecked only. The likeliest runtime surprises are:
  - Instant results failing the protocol result schema, for example a string limit hit by an unusual manifest name. The core would then fall back.
  - Hono sub-app routing under `/admin/m/forge`.
- **Double move announcement.** When an AI upgrade runs, `boss.move_added` is emitted twice: once for the rules move, then once for the AI move, whose why says "replaces X". Clients should treat the later directive as the replacement, or take the move from the ask result.
- **Optional custom signals.** The Director's habit read also counts `movement.jumped`, `movement.idle` and `movement.cover`. Games must declare these as custom signals to use them; without them, jump rate, stationary share and cover share come only from `habits` params.
- **Overlap with the core review queue.** The core's own `/admin/review` and `/admin/bake` (review table) exist in parallel with the forge's event-sourced queue at `/admin/m/forge/*`. K5 should point the dashboard at the forge routes and the `forge.gallery` projection for forge content, or K0 can bridge them.
- **Assist is world-wide.** `director.state` is world-scoped, so the assist toggle affects the whole world. Per-player difficulty would need a state-shape change.
- **Pacing directives** come only from `director.pacing` asks unless `autoPacing` is on. Tension memory lives in module kv, not the event log, so it is not part of snapshots.
- **LLM paths are unverified live.** These are the Anthropic structured-output schemas built from the manifest, such as stats objects and tag enums. A manifest with no tags uses plain strings for tags.
- **Counterforge enum casing.** D1 should send lowercase manifest element names (`fire`), or rely on the synonym and case-insensitive matching that is built in.
