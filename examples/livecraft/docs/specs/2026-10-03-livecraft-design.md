# Livecraft — design spec (2026-10-03)

**What:** a Minecraft-style voxel sandbox for the web (Three.js). It is the flagship demo of **Liveforge**, the engine-agnostic adaptive-game kit at `F:\Development\Liveforge`, built for the Cambridge × Arcade AI Hackathon, Game Tech track. The submission is a link plus a demo video, due **Sun 2026-10-04 13:30 BST**.
**Why:** tech-track judges score visible technical depth. Livecraft shows Liveforge driving agentic villagers that plan and build, a village mind that adapts raids, memory and gossip, and forge-anything. A Brain View shows the reasoning live.
**Name:** Livecraft. **Repo:** `F:\Development\Livecraft` (git, branch `main`). Liveforge is consumed as a customer would consume it (file-linked packages, like Counterforge's `scripts/link-liveforge.mjs`).
**Later:** a Godot port. For now the existing `examples/godot-village` remains the second-engine proof.

## Global constraints (bind every lane)

- **Build first, test later (user rule).** No unit tests, no reviews, no browser or engine smoke until the user says so. `typecheck` + `build` must pass.
- **Secrets.** Never read, print or copy keys or secret files (`.env`, `.dev.vars`). No live API calls from agents.
- **No downloads** beyond the npm deps already used in Counterforge and Liveforge (three, vite, typescript, @types/three). No external asset downloads.
- **Original content.** All textures and models are original and generated in code. No Mojang assets, names or logos.
- **Models.** Sonnet 5.5 (`rich`) for villager agents (including build plans) and forge designs. Haiku 4.5 (`fast`) for everything else: village mind, raid plans, barks, classification. Rules or cache always answer instantly; AI only upgrades.
- **Commits** end with a blank line + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Lane agents never spawn subagents.
- **Performance.** 60 fps on a mid laptop at render distance 6 chunks. Meshing and terrain generation run in Web Workers.

## 1. Architecture

### 1.1 Liveforge additions (kit, engine-agnostic)

| Module | Owner lane | Summary |
|---|---|---|
| **Voxel DSL** (`@liveforge/protocol` `voxel.ts`) | K6 | Schema, clamp/validate, and a deterministic `expandVoxelPlan(plan, opts)` that yields an ordered block list. Pure TypeScript with no deps, so any SDK can reuse it. |
| **builder** (`modules/builder`) | K6 | Ask `builder.plan {prompt, site:{size:[x,y,z], ground?}, palette?: string[], style?}` → `{plan: VoxelPlan, summary, materials: {block: count}}`. Instant: parametric templates (house, tower, wall, statue, bridge, farm). Upgrade: Sonnet structured output against `voxelPlanJsonSchema`. |
| **agents** (`modules/agents`) | K6 | A server-run, tool-calling agent loop for NPCs. The game registers tools (JSON Schema). The server runs a Sonnet Messages loop with **native tool use** (provider gains an additive `tools()` call). Each tool call is pushed to the game as directive `agent.tool_call {agent, callId, tool, input}`. The game executes it and posts `agent.tool_result {callId, ok, output}` (signal or route). Includes a goal stack, step budget (default 12), interruption (`agent.interrupt`), per-step thought text, and events `lf.agents.step`. Rules fallback: a scripted plan per goal template (`build`, `fetch`, `follow`, `guard`, `trade`, `go_to`). |
| **factions** (village mind) (`modules/factions`) | K7 | Per-faction (village) brain. It folds village state (population, damage, threats, trust per player, stock), a tick plans `posture` (calm, wary, hostile, festive), price multiplier and guard assignments, and ask `faction.raid_plan {faction, player}` → `{waves:[{mob, count, tactic, spawn}], captainTaunt, counters:[habit→tactic], why}` with a rules counter-table from Observer traits. Haiku upgrade. It feeds the Director timeline. |
| **record/replay cassettes** (`providers/cassette.ts`) | K7 | `LIVEFORGE_PROVIDER_MODE=live|record|replay` (default `live`) and `LIVEFORGE_CASSETTES=./cassettes`. Wraps the Anthropic client: `record` saves request-hash → response, and `replay` serves the saved response or falls through to rules (no call). Badges `source:"replay"` in metrics and why. |
| **sdk-js** | K6 (agents/builder API), K7 (factions API) | `lf.agents.register(npcId, tools: {name, description, schema, run(input)=>Promise<output>})`, `lf.agents.goal(npcId, text, context)`, `lf.agents.onStep(cb)`, `lf.builder.plan(...)` (two-stage), `expandVoxelPlan` re-export, `lf.factions.state(id)`, `lf.factions.raidPlan(...)`, and a Brain feed `lf.brain.subscribe(cb)` that merges steps, decisions, why and the source badge. |
| **dashboard** | K7 | Panels for Agents (live loops with step, thought, tool and result), Builds (plan preview as isometric points plus a DSL listing), Factions (posture, prices, plans), and a cassette mode badge. |

### 1.2 Livecraft (game)

`F:\Development\Livecraft`: npm workspace with a single app at the root (`src/`). Vite + TypeScript + three.

- **engine/**: chunk store (16×16 columns × 128 height, 16³ sections), block registry (about 40 blocks: grass, dirt, stone, cobblestone, sand, gravel, clay, snow, ice, water, lava, oak/birch/spruce log+planks+leaves, glass, bricks, stone_bricks, coal/iron/gold/diamond/redstone ore, iron/gold/diamond blocks, crafting_table, furnace, chest, torch, wool (4 colours), bookshelf, cactus, pumpkin, hay, tnt, bedrock, obsidian, door, ladder, farmland, wheat). A procedural 16×16 texture atlas is painted on a canvas (seeded noise per block, original style). Worker-based terrain generation and face-culled meshing with AO and transparency pass. Water with a simple flow-lite. Lighting: sky light plus torch light (flood fill), day/night tint.
- **world/**: seeded terrain from noise implemented in-repo (no deps). Biomes: plains, forest, desert, snowy taiga, mountains. Caves (3D noise worms), ores by depth, trees, **villages** (plains/desert: 6–10 houses from templates, well, farms, paths, villager homes and jobs: builder Bram, farmer, smith, librarian, guard captain; plus an iron golem). Spawn is near a village.
- **player/**: first-person (F5 for third person), AABB physics, sprint, sneak, swim, ladders, DDA block raycast, break with hardness/tool timing, place, hotbar (1–9, wheel), inventory (E), 2×2/3×3 crafting with about 30 recipes, furnace-lite, health, hunger-lite, fall damage, death and respawn. Creative toggle (fly, instant break, infinite blocks).
- **mobs/**: blocky box-model mobs with simple animation. Zombie, skeleton (bow), creeper (fuse/explode, crater), spider (climbs walls), pig, cow, villager, iron golem. Grid A* pathfinding (step/jump/climb aware), spawn rules (night/dark for hostiles, grass for animals), drops.
- **save/**: IndexedDB per seed (chunk diffs, player state, inventory). Liveforge holds memories.
- **liveforge/**: client service (URL/key config, offline-safe). Emitted signals: block.broken/placed (with owner when inside a villager's house), combat, items, movement.visited (village/house/biome), world.time + weather, appearance.outfit, social, economy (trades), world.property_damaged, plus play-style signals (`build.pillared`, `combat.shot_bow`, `combat.hid`) declared in the manifest. Agent tool implementations for villagers: `walk_to`, `look_at`, `mine`, `place`, `gather`, `give`, `take`, `follow`, `say`, `emote`, `build` (runs `builder.plan` → expand → stepwise place), `trade`, `guard`, `wait`. Directive handlers: npc actions, rumours/barks, faction posture, raid plans → spawner, reactions, quests, forge.ready.
- **forge**: `forge.item` → voxel item. A 16×16 pixel sprite is extruded to 3D; the AI returns a pixel grid or palette, or the rules generate one from tags. Stats, recipe and effect come from an enum: chain_lightning, fire_trail, vein_mine, knockback_burst, heal_aura, frost_slow. The item is added to the registry live.
- **ui/**: HUD (hearts, hunger, hotbar, crosshair), inventory/crafting screens, chat (T) and hold-V voice to the targeted villager, speech bubbles, quest tracker and achievement toasts, **Brain View** (bottom-left collapsible: live agent goal → steps → thought → tool → result, faction plans, Director decisions, each with model badge (Sonnet/Haiku/rules/cache/replay) and latency), **Demo panel** (`?demo`, clickable buttons top-right), Liveforge badge, dashboard link (split-screen).
- **manifest**: `F:\Development\Liveforge\examples\livecraft.liveforge.yaml` defines personas, factions, actions, signals, traits, moments, reactions (Reaction Library recipes enabled), agents tools allow-list, builder palette, raid counters, and clamps.

## 2. Demo scenarios (Demo panel buttons)

Each button stages its preconditions (time, position, inventory, seeded memories via signals) and shows a one-line caption.

1. **Build me a house.** At Bram's plot, chat or voice "build me a cosy house with a tower". `agents.goal(bram)`: Sonnet plans → `build` tool → `builder.plan` → DSL → expand → Bram gathers missing materials (`gather`/`mine`), then places blocks bottom-up (about 6 blocks/s), narrating. Brain View shows the plan, DSL, materials and every tool call.
2. **Adaptive night raid.** Set dusk and seed play style (for example many `build.pillared` + `combat.shot_bow`). `faction.raid_plan` counters it: spiders climb the pillar, creepers tunnel, skeletons spread out, and the captain taunts the habit. Guards and the golem take the positions the village mind chose. Brain View shows the threat model → plan → why.
3. **The village remembers.**
   - **A (grief):** break Mara's house. `world.property_damaged`, a rumour spreads, posture turns wary, prices rise, the golem confronts you, and a repair quest is offered.
   - **B (kindness):** repair it (Bram can co-build). Trust recovers, villagers coin a nickname, and the village builds a statue of the player via `builder.plan` in the player's outfit colours.
4. **Forge anything.** Type or say "a pickaxe made of lightning". `forge.item` returns a voxel item, stats, recipe and the chain_lightning effect. It is in the hotbar and works on the next block mined. Hyper3D upgrade path visible in the dashboard.
5. **Extra buttons:** night/day, creative toggle, give kit, teleport to village, reset village memory, open split-screen dashboard, cassette mode indicator.

## 3. Voxel DSL v1

```json
{ "name": "Cosy tower house", "palette": {"wall":"oak_planks","trim":"spruce_log","roof":"bricks","glass":"glass"},
  "ops": [
    {"op":"hollow_box","from":[0,0,0],"to":[6,4,5],"block":"wall"},
    {"op":"edges","from":[0,0,0],"to":[6,4,5],"block":"trim"},
    {"op":"roof","style":"gable","from":[-1,5,-1],"to":[7,5,6],"block":"roof"},
    {"op":"cylinder","center":[9,0,2],"radius":2,"height":8,"hollow":true,"block":"stone_bricks"},
    {"op":"door","at":[3,1,0],"facing":"south"},
    {"op":"repeat","count":3,"step":[2,0,0],"ops":[{"op":"window","at":[1,2,0],"block":"glass"}]}
  ] }
```

- **Ops:** `box`, `hollow_box`, `edges`, `line`, `cylinder` (`hollow`), `sphere` (`hollow`), `roof` (`gable`|`hip`|`flat`, `axis?`), `door`, `window`, `stairs` (`from`, `to`, `block`), `fill_air`, `repeat` (`count`, `step`, `ops`), `mirror` (`axis`, `at`, `ops`). Coordinates are integers relative to the site origin; `y` = 0 is ground level.
- **block:** a palette key or a block id. Unknown ids map to the nearest known block via the caller-supplied `blockIds` + alias table, else the palette's first entry.
- **Limits:** at most 60 ops (after repeat expansion at most 200), at most 4000 blocks, site-clamped.
- **Expansion:** deterministic, de-duplicated (last write wins), ordered by layer (y ascending), then structure before details (doors, windows, torches last), with `air` ops after solids in their layer.
- **Output:** `{blocks: [{x,y,z,block}], materials, bounds, warnings[]}`.

## 4. Brain feed contract

Every loop step, plan and decision becomes a `BrainEntry {id, ts, source: "agents"|"builder"|"factions"|"director"|"reactions"|"forge"|"persona", actor, kind: "goal"|"thought"|"tool_call"|"tool_result"|"plan"|"decision"|"line", text, data?, model?: "sonnet"|"haiku"|"rules"|"cache"|"replay", ms?}`.
- **Server:** pushes it over WS as `{t:"brain", entry}`.
- **SDK:** `lf.brain.subscribe`.
- **Display:** Brain View and the dashboard render it.

## 5. Lanes

| Lane | Repo | Depends on | Content |
|---|---|---|---|
| K6 | Liveforge (worktree `Liveforge-K6`) | n/a | Voxel DSL in protocol, builder module, agents module (+ provider `tools()`), sdk-js agents/builder/brain API, `brain` WS message, manifest keys `modules.agents/builder` |
| K7 | Liveforge (worktree `Liveforge-K7`) | n/a | factions module, cassettes, dashboard panels, sdk-js factions API, `examples/livecraft.liveforge.yaml` |
| V0 | Livecraft (`main`) | n/a | Scaffold, engine (blocks, atlas, chunks, workers, meshing, lighting), terrain/biomes/caves/ores/trees, player (physics, raycast, break/place, hotbar), day/night, IndexedDB saves |
| V1 | Livecraft (worktree) | V0 | Survival: inventory/crafting/furnace, health/hunger, mobs + pathfinding + spawning + combat + drops, creative toggle |
| V2 | Livecraft (worktree) | V0 | Villages: generation, villagers (box model, homes, jobs, schedules), iron golem, trading UI, speech bubbles, house ownership regions |
| V3 | Livecraft | K6, K7, V1, V2 | Liveforge service, signals, agent tools, builder placement, raid spawner, reactions/quests UI, forge-to-voxel items, Brain View, Demo panel, chat/voice, docs (`docs/demo-script.md`) |

Merge order: V0 → (V1 ∥ V2) and (K6 ∥ K7), then V3.
