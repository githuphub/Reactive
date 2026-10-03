# V2 report: Oakhollow (villages + villagers)

Status: built on branch `V2` (worktree `F:/Development/Livecraft-V2`), with `main` (V0 + V1) merged in. `npm run typecheck` and `npm run build` pass. Per the user rule, I wrote and ran no tests and did no browser smoke, so nothing here has been seen running yet.

## Try it

```bash
npm run dev     # http://localhost:5180 — you spawn on Oakhollow's east road, facing the plaza
```

- Look at a villager and press **E** (or right click): **Talk**, **Trade** (Bram, Mara, Hilde), **Ask to follow**. Keys 1–4 pick.
- **N** toggles name tags. You get 12 `coins` on your first visit.
- Console: `village` (the singleton), e.g.
  - `await village.controller('bram').walkTo('bram_plot')`
  - `village.setPosture('festive')` / `'hostile'` / `'wary'` / `'calm'`, `village.setPriceMult(1.6)`
  - `village.golemConfront(15)`, `village.state()`, `village.ownerAt(x, y, z)`
  - Bram builds a test hut on his plot:
    ```js
    const p = village.plots[0], b = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) for (let z = 0; z < 5; z++)
      if (y === 0 || x === 0 || x === 5 || z === 0 || z === 4) b.push({ x, y, z, block: y === 0 ? 'cobblestone' : 'oak_planks' });
    await village.controller('bram').buildPlan({ blocks: b }, { origin: p.origin, onProgress: console.log });
    ```
  - Co-build repair after grief: `await village.controller('bram').buildPlan(village.repairPlan('mara_house'))`.

## What's built

### The village (`gen/*`, `layout.ts`, `stamp.ts`, `gen-pass.ts`)
- `planVillage(seed, site)` is a pure, cached layout. The gen worker stamps it; the main thread uses the same function for ownership, anchors, posts and repair snapshots. Only built-in blocks are stamped (no block registration, so worker/main ids can't drift).
- Frame: plaza centre **O = (site.x, site.z + 3)**, ground block `y0 = site.y − 1`, villagers stand at `y0 + 1`. Everything sits within ~33 blocks of the site centre (inside the fully flattened radius 34). The player spawn column (`site.spawn` = O + (30, 0)) lands on the main road and stays clear.
- Roads (dirt path, gravel edges): E–W main road (z −1..1, x −31..31), N–S road, two back lanes (z −15) and a farm lane (x −15). Straight paths from every entrance to the nearest road.
- Plaza (11×11, stone rings) with a well (4×4, water, log posts, canopy), a bell frame (gold bell), a notice board, glow-lamp corner posts. Torch lamp posts along the roads. East gate (stone pillars, timber lintel, lamps, banner). A small green with flowers and a bench. Mara's garden (pumpkins, hedge).
- 10 buildings from parametric templates (`gen/templates.ts`, rotated by `gen/local.ts`; plains = timber/brick, desert = sandstone):

| id | kind | owner | O-relative footprint |
|---|---|---|---|
| `bram_house` | small_house | bram | (−26,−23) 7×7, door south |
| `house_a` | small_house | villager_1 | (−15,−24) 7×8, door south |
| `builders_yard` | yard (piles: planks, cobble, bricks, logs, stone bricks, glass) | bram | (−32,−12) 8×10, open east |
| `smithy` | smithy (open front, lava forge, furnaces, iron anvil, chimney) | hilde | (7,−11) 9×7 |
| `hilde_house` | large_house (2 storeys, ladder) | hilde (+villager_4) | (18,−14) 9×9 |
| `library` | library (bookshelves, carpet aisle, slate roof) | pip | (4,−27) 11×9 |
| `mara_house` | cosy_house: Tudor frame, plaster, **thatched roof**, chimney, flower boxes, hay doormat | mara | (−13,4) 7×6, door north |
| `farm_hut` | farm_hut | mara | (−12,13) 5×5, door west |
| `house_b` | small_house | villager_3 | (7,4) 7×7, door north |
| `guard_tower` | tower (ladder, lookout platform, merlons, banner) | rowan | (21,4) 5×5, door north |

- Two farms (9×7: log border, farmland, water channel, wheat at mixed stages, a scarecrow), owner mara. Wheat slowly regrows at runtime.
- **Bram's plot**: a cleared 14×10 dirt lot at O + (−22..−9, −13..−4), corner posts with torches, a sign post and a floating "Bram's Plot · build site" label.

### Ownership, plots, posts (`village.ts`)
- `village.buildings: Building[]` — `{ id, owner, kind, name, bounds{min,max}, door, entrance, bed, beds, work, dynamic }`.
- `village.ownerAt(x, y, z) → { buildingId, owner } | null`. Exact for the template's blocks (from a dry run of the template) plus anything inside the footprint, so repairs (`block.placed`) and grief (`block.broken`) both resolve to the owner. Runtime builds registered with `registerAs` / statues count too.
- `village.plots[0]` (Bram's): `{ id: 'bram_plot', owner: 'bram', rect, origin (min corner at stand level, pass as builder origin), size: [14, 16, 10], sign, front }`.
- `village.posts`: `gate` (O+(26,0)), `tower` (tower top platform), `tower_base`, `well` (O+(3,3)), `mara_house` (outside her door), `plaza` (O+(−3,3)), `farm`, `bram_plot`, `yard`, plus manifest aliases `square` → plaza and `walls` → gate.
- `village.statueSpot`: `{ origin: O+(2, ·, 2), size: [4, 8, 4] }` (plaza SE quadrant, by the well).

### Villagers (`npc/*`)
- Box models (`npc/model.ts`): big head, long nose, profession robe with apron/belt/collar details, short legs, **folded arms when idle** (separate arms while working/emoting), hats (builder's cap, straw hat, smith's bandana, librarian cap + glasses, guard helmet + plume), a beard option, movable brows for posture faces, a party hat (festive), a carried-block slot and a sword (guards). The golem is a 1.25× iron giant with vines, long arms, red angry eyes and a poppy.
- Entity types: villagers are **`villager`** (V1's `PREY_TYPES` default, so hostiles hunt them), the golem is **`iron_golem`**. `entity.data.npcId` holds the id.
- Name tag above the head (N toggles) and a typewriter speech bubble (3D-anchored DOM).
- Cast (`npc/cast.ts`), ids matching the manifest:

| id | name | role | home | work |
|---|---|---|---|---|
| `bram` | Bram | Builder (trader) | bram_house | builder's yard |
| `mara` | Mara | Farmer (trader) | mara_house | farms (harvest + replant) |
| `hilde` | Hilde | Smith (trader) | hilde_house | smithy (anvil, furnace, sparks) |
| `pip` | Pip | Librarian | library | library (reads at the shelves) |
| `rowan` (alias `captain_rowan`) | Captain Rowan | Guard captain (sword, fights) | guard_tower | patrol by day, night watch |
| `iron_golem` (alias `golem`) | Iron Golem | Guardian (fights, confronts) | — | patrols the posts |
| `villager_1..3/4` | seeded names (Tobin, Wren, …) | farmhand / labourer / scholar / villager | house_a, house_b, hilde_house | farm / yard / library / plaza |

- Named villagers are immortal: at 1 hp they become `injured` (sad face, go home, heal over time).
- **Schedules** (`npc/schedule.ts`): day work → evening gathering in a ring around the well (chatting) → night home, door shut, lie down in bed. Hostiles within 18 blocks, injury or hostile posture send villagers indoors. Guards and the golem fight hostiles within ~14–16 blocks. Festive posture: everyone parties at the plaza.

### VillagerController (`npc/controller.ts`) — the agent tool surface
`village.controller(id)` (accepts aliases). Every method is async, resolves on completion with `{ ok, detail, data? }`, never throws on normal failure, accepts `{ onProgress, signal, priority }`, and is cancelled by `cancel()`.

```ts
walkTo(target, { run?, reach? })          // target: post, building id, npc id/name, 'player', 'home', 'work', 'plot', 'x,y,z', {x,y,z}, entity
lookAt(target)
mine(pos)                                  // drops go to npc.bag
place(pos, block, { facing?, meta? })      // doors (both halves), wall torches, ladders, orientables handled
gather(block, count, { near?, fromWorld?, radius? })  // yard piles (unlimited) | wheat harvest+replant | mine nearby
give(item, count, to = 'player')           // player gets it in the inventory (toast)
take(item, count, from = 'player')
follow(target, { distance = 3 })           // mode; resolves once following starts
stopFollow()
say(text, { emote?, seconds? })            // resolves after the line has been read
emote(kind)                                // wave nod shake think cheer hammer glare stare laugh shrug bow cry; golem: creak stamp offer_flower
guard(post | pos)                          // walk there, hold the post, guards fight hostiles nearby
trade({ priceMultiplier?, waitForClose? }) // opens the trade screen
wait(seconds)
buildPlan(expanded, { origin?, blocksPerSecond = 6, onProgress, scaffold = true, fetchMaterials = true, reach = 5, source = 'village', narrate = true, registerAs? })
cancel()
// state: activity, busy, agentControlled, currentMode, releaseToSchedule()
```

- Body actions (walkTo, mine, place, gather, give, take, guard, buildPlan, follow) replace each other; overlays (say, lookAt, emote, wait) run alongside.
- Priority: `'agent'` (default) preempts the schedule, which then pauses for 45 s after the last agent action (`AGENT_GRACE`); schedule actions never interrupt agent actions.
- **buildPlan**: takes Liveforge's `expandVoxelPlan` output as is (`{x,y,z,block,facing?}`; `"air"` clears; `origin` is added, omit it when blocks are already world coordinates). It walks to the yard piles for the missing materials first (top 3 piles, swings, carries a block), then places in the given order at ~6 blocks/s with a swing, particles and a carried block of the current material. It walks into reach (5 blocks from the eye) and hops onto blocks placed under its feet. For high blocks it builds a dirt pillar beside the footprint, climbs it, and removes it afterwards (also on cancel). It defers blocks where the player stands, narrates (Bram's build lines at start/half/near done/end) and returns `{ placed, skipped, total, bounds, warnings }`.
- Doors: villagers open doors on their path and close them behind them (source `'village'`, so V3 can ignore those edits). Every villager edit uses source `'village'` and `entity: npc`.
- If a path can't be found (or the NPC gets stuck), walking falls back to a short teleport near the target with a puff of particles ("took a shortcut"). This keeps demos moving; it's off inside `buildPlan` reach moves.

### Trading (`trade/*`)
- Offers for Hilde (tools, ingots; buys coal, iron ore, gold), Mara (bread, apples, seeds, pumpkins, hay; buys wheat) and Bram (planks, bricks, glass, stone bricks, glow lamps, doors, torches; buys logs, cobble). The currency is the `coins` item (original coin icon).
- `village.setPriceMult(mult)`: open screens re-price live, with a coloured "prices ×1.30" badge. Buying costs `ceil(price × mult)`; selling pays `max(1, floor(price / mult))`. `controller.trade({ priceMultiplier })` overrides it per session.
- Haggle button → `village.onHaggle(req)` hook (`{ npc, offer, multiplier, attempts } → { accepted, multiplier?, line? }`, may be async). Default: rules (55%/25% chance of −10%, refuses when hostile). Max 3 per session.
- Events (typed by declaration merging in `village/events.ts`): `traded {npc, item, count, price, kind, multiplier}`, `haggled {npc, accepted, multiplier, line}`.

### Interaction and hooks
- `village.onTalk = (npc) => …` (V3 opens chat). Default: a rules bark (greeting/barks from the manifest personas, posture/weather-aware). Emits `villagerTalk {npc}`.
- Other events: `villagerAction {npc, action, ok, detail}` (every agent-priority action), `villagePosture {posture, prev}`, `golemConfront {active, reason}`, `villageDamaged {buildingId, owner, x, y, z, block}` (player broke an owned block).

### Village state for V3
- `village.state()` → `{ population, injured[], posture, priceMult, hostilesNear, buildings[{id, owner, kind, damaged, total}], damagedTotal, golemConfronting, npcs[{id, name, activity, injured, x, y, z}] }`.
- `village.setPosture('calm' | 'wary' | 'hostile' | 'festive')`:
  - wary: raised brows, villagers watch the player from further away;
  - hostile: angry faces and red golem eyes, every front door shut, guards draw swords, non-guards go indoors, haggling refused;
  - festive: party hats, wool bunting around the plaza and banners by the doors (placed and later removed as source `'village'`), everyone gathers to cheer.
- `village.spawnStatue(expanded, at?)` places a plan progressively (40 blocks/s, particles) at `village.statueSpot` (or a post/point) and registers it as a `village`-owned region.
- `village.repairTracker(buildingId)` → `{ original (template snapshot), missing(), damaged(), restoreProgress() }`. Progress is relative to the worst damage seen since the tracker was made.
- `village.repairPlan(buildingId)` → the missing blocks bottom-up, ready for `buildPlan` (Bram co-builds the repair).
- Built-in rules reactions (`village.autoReactions = true`; set false when V3 drives reactions): an owner shouts when you break their house and nearby villagers glare. 3 grief breaks in 60 s, hitting the golem, or hitting villagers twice in 30 s → the golem confronts you for 20 s (follows, angry face, pushes you back; no damage). `village.golemConfront(seconds)` triggers it directly.

### V1 integration (main merged)
- Villager entity type is `villager` (V1 `PREY_TYPES`), golem `iron_golem` (V1 mobs retaliate against attackers).
- Natural hostile spawns are vetoed within `site.radius + 8` of the village centre via `getSpawnDirector(game).onNaturalSpawn` (raids via `spawnWave` are unaffected).
- Hostile detection uses V1's `mob.category === 'hostile'` (falls back to a type list / `entity.data.hostile`).
- The plugin runs at order 5 (before survival's 10) so E on a targeted villager opens the villager menu instead of the inventory.

## Public import

```ts
import { village } from '../village';       // src/village/index.ts re-exports the API and types
await village.ready;                         // resolves when the cast has spawned
```

## File map

```
src/village/
  index.ts          public exports
  plugin.ts         plugin (order 5): items, attach, system, save slots, ready → spawn, menu keys, spawn veto
  gen-pass.ts       gen worker pass → stamp.ts
  stamp.ts          draws the layout elements touching a chunk
  layout.ts         planVillage(seed, site): roads, plaza, buildings, farms, plot, posts, generics; anchors/record helpers
  gen/local.ts      local→world frame + metadata rotation for templates
  gen/palette.ts    plains/desert palettes, per-building style rolls
  gen/templates.ts  small/large/cosy house, smithy, library, farm hut, tower, yard
  gen/decor.ts      roads, plaza, well, bell, notice board, lamps, gate, farms, plot, green, garden
  village.ts        Village singleton: ownership, posts, plots, state, posture, prices, statues, repairs, doors, reactions, save
  nav.ts            Navigator interface + GridNavigator (grid A*)
  events.ts         GameEvents augmentation (traded, haggled, villagerAction, villagePosture, villagerTalk, golemConfront, villageDamaged)
  items.ts          coins item + icon
  npc/cast.ts       named cast + generic villager rolls
  npc/model.ts      villager/golem box models
  npc/npc.ts        Npc entity: path following, doors, animation, emotes, sleep, faces
  npc/controller.ts VillagerController action API
  npc/schedule.ts   daily schedule brain
  npc/effects.ts    particles, block colours
  trade/offers.ts   offers + pricing
  trade/screen.ts   trade screen + haggle
  ui/bubbles.ts     name tags, speech bubbles, world labels
  ui/menu.ts        villager interaction menu
  ui/styles.ts      injected CSS
```

## Shared-file edits

None. No V0 or V1 file was changed; new events use declaration merging. `main` was merged into `V2` with no conflicts.

## Gaps and concerns

- **Never run.** Typecheck and build only. Riskiest: template geometry (roof/door/torch orientation after rotation), path following and door timing, ladder climbing (tower top), scaffold pillars in `buildPlan`, model part offsets (brows, hats, held block), bubble placement.
- **Id mismatch with the manifest:** the brief says `rowan`; the manifest persona is `captain_rowan` (and lists it in `factions.members/guards`). `village.npc()`/`controller()` accept both, but V3 should pick one for signals. The manifest posts are `gate, square, well, farm, walls`; all resolve (`square`→plaza, `walls`→gate) alongside the brief's `gate, tower, well, mara_house, plaza`.
- **Currency:** the brief says coins; the manifest lore says emeralds. Items use `coins`; `emerald(s)` is an alias for give/take.
- **Navigator:** kept my `GridNavigator` rather than swapping to V1's `pathfind`/`MobBrain`. The controller also uses its `standable/passable/snap` helpers. A swap is possible behind `Navigator` but wasn't cheap enough to do safely here.
- **Teleport fallback** when walking fails (documented above): good for demos, but it can look like a jump cut.
- No custom blocks (bells, fences, beds and signs are built from existing blocks), so worker/main block ids can't drift with V1's registrations.
- Villagers aren't saved beyond position and bag; posture, price multiplier, festive decorations and runtime-registered buildings are saved in the `village` slot.
- Golem pushes but never damages the player (by design; V3 could call V1's `hurtPlayer` if wanted).
