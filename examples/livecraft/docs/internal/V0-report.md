# V0 report: Livecraft voxel core

Status: built. `npm run typecheck` and `npm run build` pass. Per the user rule, I wrote and ran no tests and did no browser smoke, so nothing here has been seen running yet.

## Try it

```bash
npm install
npm run dev        # http://localhost:5180
```

URL params:
- `?seed=<text|number>`: deterministic world (default `livecraft`).
- `?fresh`: wipe this seed's save and start a new world.
- `?creative`: start in creative mode.
- `?rd=2..10`: render distance.
- `?time=noon|dusk|night|0.6`: start time.
- `?weather=rain|storm|snow`: start weather.

Controls:

| Input | Action |
|---|---|
| WASD | Move |
| Space | Jump. Double-tap toggles flight in creative. |
| Shift | Sneak. You don't fall off edges. |
| Ctrl, or double-tap W | Sprint |
| Hold LMB | Break |
| RMB | Place or use |
| MMB | Pick block |
| 1–9, mouse wheel | Select hotbar slot |
| F3 | Debug overlay |
| F5 | Cycle view (first person, back, front) |
| F1 | Hide HUD |
| Esc | Pause menu: render distance, FOV, sensitivity, view bob, game mode, seed |

`window.game` exposes the `Game` object in the console.

## Architecture map

```
src/
  main.ts            entry: URL params → Game.create → initPlugins → game.start()
  game/              glue
    game.ts          Game: owns all subsystems, frame loop, breakBlock/placeBlock/toggleDoor, setTime/setWeather/setGameMode, worldToScreen
    events.ts        typed EventBus + GameEvents (all event payloads)
    plugins.ts       auto-discovers src/*/plugin.ts (GamePlugin)
    time.ts          TimeOfDay (20 min day, timeScale, phases, daylight, sun direction)
    settings.ts      localStorage settings (renderDistance, fov, sensitivity, viewBob)
  engine/
    constants.ts     chunk dims, block packing (12-bit id + 4-bit meta), keys, atlas layout
    blocks.ts        block registry (55+ built-ins, BLOCK ids, registerBlock, flags arrays)
    items.ts         item registry (tools by tier, food, materials, block items), drops, breakTime
    textures.ts      procedural 16×16 painters for every block/item (registerTexture)
    paint.ts         pixel-art toolkit (palettes, tileable noise, voronoi, lines)
    atlas.ts         TextureAtlas: 1024² canvas, 32 px slots with 8 px wrap/clamp padding, animated frames
    block-table.ts   typed-array snapshot of registry + atlas for mesh workers
    chunk.ts         Chunk: Uint16 blocks, Uint8 light (sky<<4 | block), heights, biomes, section counts
    world-store.ts   WorldStore: queries, setBlock (events, light, remesh marks, support rules, save diff), raycast
    light.ts         lightChunkLocal (worker) + LightEngine (seams + bounded incremental BFS)
    mesher.ts        section mesher: culled faces, vertex AO, smooth light, 3 passes, cross/liquid/door/ladder/torch
    mesh.worker.ts   mesher worker
    worker-pool.ts   promise worker pool
    chunk-manager.ts streaming: gen requests by distance, light stitching, mesh dispatch, budgeted upload, unload, frustum-culled section meshes
    chunk-material.ts terrain ShaderMaterial (vertex light × daylight, warm block light, AO, fog, anim frames)
    shapes.ts        collision + selection boxes per block
    physics.ts       Body, moveBody (AABB vs voxels), stepBody (gravity, swim, ladders, jump), bodyCollides
    entity.ts        Entity base class (hurt/knockback/death, lookAt, data bag)
    entities.ts      EntityManager (update loop, query/nearest/raycast, lighting)
    box-model.ts     blocky box models with procedural skins + humanoid walk animation
    sky.ts           gradient dome + sunset glow, sun/moon, stars, drifting clouds; fog colour/sky tint
    weather.ts       rain/snow particles around the camera, darkening, storm lightning
  world/
    noise.ts         seeded simplex 2D/3D + fBm
    terrain.ts       Terrain (pure per-seed functions: heights, biomes, caves, village site, flatten)
    biomes.ts        biome ids/names
    trees.ts         jittered-grid trees (oak, birch, spruce, cactus) drawn across chunk borders
    gen.ts           generateChunk pipeline + GenContext/GenPass (auto-discovers src/*/gen-pass.ts)
    gen.worker.ts    generation worker
    fluids.ts        water/lava flow-lite (+ lava/water → obsidian/cobblestone)
  player/
    player.ts        controller (walk/sprint/sneak/jump/swim/ladder/fly), camera views, fall hook, serialize
    interaction.ts   targeting, breaking with crack stages, placing rules, attack/interact entities, pick block
    inventory.ts     36-slot inventory, 9-slot hotbar, infinite (creative-ish) flag, tool wear
    input.ts         keyboard/mouse/pointer lock, KEYS bindings
    held-item.ts     first-person held block/item with swing
    player-model.ts  third-person model (original outfit)
  save/save.ts       SaveManager (IndexedDB per seed: chunk diffs + registered state slots)
  ui/                UI (HUD anchors, screen stack, toasts), hotbar, debug overlay, loading, pause, icons
  village/gen-pass.ts  V2-owned stub (no-op village pass, auto-discovered)
  mobs/, liveforge/  empty, for V1 / V3
```

Frame order (`Game.frame`), when not paused:
1. time
2. player
3. interaction
4. entities
5. fluids
6. `addSystem` systems
7. the `tick` event

Every frame:
1. camera
2. chunk streaming
3. sky
4. weather
5. uniforms
6. render

## Extension API (for V1, V2, V3)

Rule of thumb: create files in your own folder. Hook in through plugins, events, systems, entities, UI anchors and save slots. You shouldn't need to edit V0 files.

### 1. Plugins (auto-discovered)

Create `src/<folder>/plugin.ts` with a default export. There's no shared file to edit.

```ts
import type { GamePlugin } from '../game/plugins';
const plugin: GamePlugin = {
  name: 'survival',
  order: 10,                       // lower runs first (default 100)
  init(game) { /* register blocks/items, subscribe, addSystem, mount UI, save.register */ },
};
export default plugin;
```

`init` runs after the save is loaded and before chunks stream in. V1 uses `mobs/plugin.ts`, V2 `village/plugin.ts` and V3 `liveforge/plugin.ts`.

### 2. Game events (`game.events.on(name, cb)`, returns unsubscribe)

| Event | Payload / notes |
|---|---|
| `blockChanged` | `{x,y,z,id,meta,prevId,prevMeta,source}`. Every post-gen change (player, fluids, support, systems). |
| `blockBroken` | `{x,y,z,id,meta,source,tool,drops,dropsHandled,entity?}`. Set `dropsHandled = true` if you spawn item entities (V1); otherwise survival players get drops in the inventory. |
| `blockPlaced` | `{x,y,z,id,meta,prevId,source,entity?}` |
| `blockInteract` | `{x,y,z,id,meta,item,sneaking,handled}`. RMB on a block. Set `handled` to cancel the default (door toggle/place). Use it for crafting tables, furnaces and chests. |
| `playerMoved` | Throttled to block changes: `{x,y,z,bx,by,bz,cx,cz,biome}` |
| `playerChunkChanged` | `{cx,cz,prevCx,prevCz}` |
| `playerFell` | `{distance, damage}`. Survival only. Damage = floor(distance − 3). V1 applies it. |
| `playerRespawned` | `{x,y,z}` |
| `playerAttack` | `{entity,item,handled}`. LMB on an entity. If not handled: `entity.hurt(tool damage or 1)`. |
| `entityInteract` | `{entity,item,sneaking,handled}`. RMB on an entity (trade, talk). |
| `entityAdded`, `entityRemoved` | `{entity}` |
| `entityHurt`, `entityDied` | `{entity, amount?, source: DamageSource}` |
| `timeChanged` | `{time,day,phase,daylight}`. About once a second and on phase change. |
| `phaseChanged` | `{phase: 'dawn'\|'day'\|'dusk'\|'night', prev, day}` |
| `weatherChanged` | `{weather, prev}` |
| `gameModeChanged` | `{mode}` |
| `chunkLoaded`, `chunkUnloaded` | `{cx,cz}` |
| `hotbarChanged`, `inventoryChanged` | Hotbar/inventory updates |
| `tick` | `{dt, elapsed}`. Every simulated frame. |
| `ready` | Spawn area loaded and the player is in control |
| `paused`, `resumed`, `settingsChanged` | |

`BlockSource` values:
- `'player'`
- `'entity'`
- `'explosion'`
- `'fluid'`
- `'support'`
- `'gen'`
- `'village'`
- `'liveforge'`
- `'system'`
- any string

Pass a `source` on every edit so V3 can tell who changed what.

### 3. Blocks and items

- `BLOCK.<name>` holds numeric ids of built-ins (e.g. `BLOCK.oak_planks`).
- `BLOCK_IDS: string[]` holds names in id order.
- `blockByName(name)` throws on unknown names. `findBlock(name)` and `blockById(id)` are also available.
- `game.blocks` and `game.items` are facades over the same functions.
- Runtime registration:
  - `registerBlock({ name, textures, renderType, hardness, tool, harvestTier, drops, light, ... })`
  - `registerItem({ name, tool, food, places, icon, maxStack })`
  - `registerTexture(key, painter, { frames, pad })`
  - The atlas paints new textures automatically and mesh workers get the new table. Register in a deterministic order (plugin `init`), because ids must stay stable for saves.
- Every block has an implicit block item with the same name. Tools are `<wooden|stone|iron|golden|diamond>_<pickaxe|axe|shovel|hoe|sword>`, plus `shears`. Other items:
  - `stick`
  - `coal`
  - `iron_ingot`
  - `gold_ingot`
  - `diamond`
  - `redstone`
  - `wheat`
  - `wheat_seeds`
  - `book`
  - `string`
  - `feather`
  - `flint`
  - `apple`
  - `bread`
  - `door`
- Helpers:
  - `computeDrops(block, meta, tool)`
  - `breakTime(block, tool)`
  - `canHarvest(block, tool)`
  - `ItemStack = {item, count, damage?, data?}`
- Block metadata (4 bits):
  - Facing (0 N, 1 E, 2 S, 3 W) for orientable blocks and ladders.
  - Torch: 0 floor, 1–4 wall (facing + 1).
  - Door: facing | 4 open | 8 upper half.
  - Wheat: stage 0–7.
  - Liquids: level (0 = source).
- Built-ins include everything in spec §1.2, plus:
  - `tall_grass`
  - `red_flower`
  - `yellow_flower`
  - oak, birch and spruce saplings
  - `dead_bush`
  - `snowy_grass`
  - `sandstone`
  - `dirt_path` (for V2 village paths)
  - `glow_lamp` (light 15)
  - `green_wool`
  - `black_wool`
  - `mossy_cobblestone`

### 4. World queries and edits (`game.world: WorldStore`)

- Reads:
  - `getBlock`, `getMeta`, `getRaw`, `getBlockName`
  - `getSkyLight`, `getBlockLight`
  - `getLight(x,y,z, daylight)`: effective 0..15. Use it for spawn rules, e.g. hostile if ≤ 7 with `game.time.daylight`.
  - `isSolid`, `isOpaque`, `isLiquid`, `isReplaceable`
  - `isLoaded(x,z)`
- Terrain queries:
  - `heightAt(x,z)`: top non-air block. Falls back to the terrain estimate for unloaded chunks.
  - `topSolidY(x,z)`
  - `findGround(x,z,fromY?)`: feet y with 2 blocks of headroom, or null.
  - `biomeAt(x,z)`
- Edits:
  - `setBlock(x,y,z,id,{meta, source, drops, tool, entity, silent})`. It fires events, relights, marks dirty sections (including neighbours), records the save diff and applies support rules (plants, torches, ladders, door halves).
  - `setBlockByName(...)` takes a block name instead of an id.
- `raycast(origin, dir, maxDist, {liquids, filter})` returns `{x,y,z,id,meta,face,normal,place,distance,point}`.
- Game helpers:
  - `game.breakBlock(x,y,z,{source,tool,entity,drop})` rolls drops by tool tier.
  - `game.placeBlock(x,y,z,nameOrId,{meta,source,entity})`
  - `game.toggleDoor(x,y,z,open?)`
- `game.terrain` (pure, works for unloaded areas): `heightAt`, `biomeAt`, `column`, `isCave`, `villageSite()`.

### 5. Entities (V1 mobs, V2 villagers/golem)

```ts
import { Entity } from '../engine/entity';
import { createBoxModel, animateHumanoid } from '../engine/box-model';
class Zombie extends Entity {
  readonly type = 'zombie';
  model = createBoxModel({ id: 'zombie', parts: [/* head/body/arms/legs */] });
  constructor() { super(); this.object3d = this.model.root; }
  update(dt: number) {
    const dir = /* AI */;
    this.move(dt, { moveX: dir.x * 2.5, moveZ: dir.z * 2.5, jump: this.collidedHorizontally });
    animateHumanoid(this.model, phase, 1);
    this.model.tick(dt);
  }
}
game.entities.add(new Zombie()).position.set(x, y, z);
```

- `Entity` fields:
  - `position` (feet), `velocity`, `yaw` (0 faces −Z), `width`, `height`, `eyeHeight`
  - `onGround`, `inWater`, `inLava`, `onLadder`, `collidedHorizontally`, `fallDistance`
  - `health`, `maxHealth`, `hurtCooldown`
  - `data` (free-form), `object3d`
- `Entity` methods:
  - `hurt(amount, {kind, entity?, player?, item?})`: knockback, `entityHurt`/`entityDied` events, `onDeath`, removal.
  - `lookAt`, `forward`, `eye`, `remove()`.
- The manager:
  - Calls `update(dt)` only while the entity's chunk is loaded.
  - Syncs `object3d` position/yaw.
  - Tints box models by local light (`applyBrightness`).
  - Removes entities that fall below y −32.
- `game.entities`:
  - `add`, `remove`, `get(id)`, `all()`
  - `ofType(type)`, `query(center, r, filter)`, `nearest(...)`
  - `raycast(origin, dir, max, ignore)`
- Physics for custom movers:
  - `moveBody(world, body, dt, {sneakEdge})`: collide only.
  - `stepBody(world, body, dt, {moveX, moveZ, jump, accel, jumpVelocity})`: gravity, swim, ladders. Returns the fall distance on landing.
  - `bodyCollides(world, x,y,z,w,h)`
  - The player uses the same `moveBody`.
- `createBoxModel({id, parts:[{name,parent?,size:[w,h,d],pivot,offset?,skin: color | painter}]})` gives `{root, parts, setBrightness, flash, tick, dispose}`. Sizes are in 1/16-block pixels. Textures are cached per `id`.

### 6. Village stamp hook in generation (V2)

- `src/village/gen-pass.ts` (V2-owned stub, auto-discovered by `world/gen.ts`) default-exports a `GenPass {name, order, run(ctx)}`. Put the stamp in `village/stamp.ts` and call it from `gen-pass.ts`. Any `src/*/gen-pass.ts` works.
- `run(ctx)` runs in the gen worker after terrain, caves, ores, trees and plants, and before saved diffs and lighting.
- `ctx` provides:
  - `seed`, `cx`, `cz`, `x0`, `z0`
  - `terrain`
  - `site: VillageSite | null`
  - `blocks` (raw), `biomes`
  - `inChunk(x,z)`, `get(x,y,z)`, `set(x,y,z,id,meta)`. World coordinates; out-of-chunk writes are ignored, so draw whole structures every time.
  - `surfaceY(x,z)`
  - `rng(salt)` (deterministic)
- `findVillageSite(seed)` (`world/terrain.ts`) returns `{x, z, y, radius: 44, biome, spawn:{x,z}}`. It is a dry, flat-ish plains or desert area found by spiral search from the origin.
  - The terrain already flattens the site: the top solid block is at `site.y − 1` inside `radius − 10`, and it blends out to `radius`.
  - No trees grow in the site. Caves stay at least 6 blocks below the surface there.
  - Grass, flowers and pumpkins may still be there; overwrite them.
- The player spawns at `site.spawn`, inside the east edge of the site, facing the centre. Keep that column clear, or set `game.player.spawnPoint` and teleport in your plugin.
- Make the village layout a pure function of `(seed, site)`. The main thread (villager homes, ownership regions) and the worker (blocks) can then both compute it.
- Gen workers don't run plugins. Blocks you stamp must be built-ins, or registered in a module imported by `gen-pass.ts`, in the same order as on the main thread.

### 7. Time and weather (V3)

- `game.time`:
  - Fields: `time` (0..1; 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight), `day`, `dayLength` (1200 s), `timeScale`.
  - Getters: `daylight`, `phase`, `isNight`, `hours`, `sunDirection()`.
- `game.setTime(0.6 | 'dawn'|'day'|'noon'|'dusk'|'night'|'midnight')`
- `game.setWeather('clear'|'rain'|'storm'|'snow')`
- `game.weather.intensity` and `game.weather.darkening` are read-only.
  - Rain becomes snow in snowy taiga and is hidden in deserts.
  - Storms flash lightning.

### 8. UI mount points

- `game.ui.mount(anchor, el, {order})` returns an unmount function.
  - Anchors: `top-left` (debug overlay), `top-center`, `top-right`, `center` (crosshair), `bottom-left`, `bottom-center`, `bottom-right`.
  - The hotbar sits in `bottom-center` with order 100. Hearts and hunger go above it with order < 100.
- `game.ui.hud` is the raw full-screen HUD layer, for absolutely positioned speech bubbles. Use `game.worldToScreen(x,y,z)` to get `{x,y,visible,distance}`.
- `game.ui.screens` is the screen stack: `open(screen)`, `close(screen?)`, `toggle`, `has(id)`, `top`, `isOpen`.
  - A `Screen` is `{id, el, pausesGame?=true, dim?=true, onOpen, onClose, onKey(e) → handled}`.
  - While a screen is open, pointer lock is released and gameplay input is disabled.
  - Esc closes the top screen. Use `onKey` to close an inventory on E.
- `game.ui.toast(text, {seconds, kind})`
- `game.icons.icon(itemName)` returns a cached 32×32 canvas (iso cube for blocks). `game.icons.drawInto(canvas, item)`.
- Input:
  - `game.input` has `isDown`, `wasPressed`, `onKey(cb)` and `KEYS` (`inventory` = E, `chat` = T, `drop` = Q).
  - Text inputs inside screens receive keys normally.
- CSS classes in `ui/styles.css`: `.lc-panel`, `.lc-btn`, `.lc-row`, `.lc-slot`.

### 9. Save API

```ts
game.save.register('mobs', () => data, (saved) => restore(saved)); // restores immediately if saved
game.save.markDirty('mobs');                                        // debounced write (1.5 s)
```

- Values must be structured-cloneable.
- All slots are also written every 10 s, on pause and on page hide.
- `game.save.has(key)` and `get(key)` read saved values.
- Chunk diffs are automatic for every `setBlock`.
- Built-in slots: `player` (pos, rot, mode, flying, spawn), `inventory` (slots, selected, infinite) and `world` (time, day, weather).
- Health and hunger belong to V1. Use `game.player.data` or your own slot.

### 10. Player and inventory

- `game.player`:
  - `position`, `yaw`, `pitch`, `mode`, `flying`, `sneaking`, `sprinting`, `spawnPoint`, `frozen`, `viewMode`, `data`
  - `eye()`, `lookDir()`, `facing`, `teleport()`, `respawn()`, `setMode()`
- `game.setGameMode(mode)`, `game.teleportPlayer(x, y|null, z)`
- `game.inventory`:
  - `slots[36]` (0–8 is the hotbar), `selected`, `infinite`
  - `add(stack)` returns the leftover count; `remove`, `count`, `set`, `get`, `consumeSelected`, `damageSelected`
  - `serialize`, `deserialize`
  - V0 default: `infinite = true` with a starter loadout. V1 should set `infinite = false` for survival and call `fillDefaults` or its own setup.
- `game.addSystem({name, update(dt)})` adds a per-frame system that pauses with the game.

## Notes and decisions

- **Lighting:** sky light (15 straight down) and block light are flood-filled.
  - Water, ice and leaves attenuate light.
  - Each chunk is lit in its worker, then the main thread stitches borders and handles incremental updates (removal plus re-add BFS, bounded to 400k steps).
  - Smooth vertex light and AO are baked; the shader scales sky light by daylight and the sky tint (warm at sunset, cool at night).
- **Rendering:**
  - Three passes: opaque, cutout (leaves, plants, glass, doors, ladders, torches; double-sided) and transparent (water, ice).
  - Fog goes to the horizon colour at the render-distance edge, and turns blue and short underwater.
  - Leaves cull faces between leaves (cheaper; the holes still show the inside).
- **Atlas:** mipmaps are on (`NearestMipmapLinear`) and are safe because of the 8 px wrapped padding; sprites use clamp padding.
- **Workers:** n = min(4, hardwareConcurrency − 1) mesh workers and ceil(n/2) gen workers.
  - Generation radius is RD + 1.6, so sections have all 8 neighbours for AO and light; unloading happens past RD + 3.
  - Uploads have a 4 ms budget per frame. Player edits are meshed and uploaded first.
- **Fluids:** flow-lite. Water reaches 6 blocks and lava 3. They fall, dry up when cut off, and lava turns to obsidian or cobblestone on contact with water. Generated lakes are static until disturbed.

## Gaps and concerns

- **Never run:** no browser smoke per the user rule. The typecheck and the build are the only checks. The riskiest untested parts are:
  - GLSL in `chunk-material.ts`, `sky.ts`: relies on three's GLSL1 → 3 compatibility defines for `texture2D` and `gl_FragColor`.
  - The light seam and incremental code.
  - The mesher's AO tables.
  - Tuning: worldgen biome scale, tree density and cave frequency.
- **Ctrl sprint:** Ctrl+W closes the browser tab and the page can't block it. Double-tap W also sprints.
- **Saved runtime-registered blocks:** if a save contains blocks registered at runtime, the gen worker doesn't know their light flags and treats them as transparent until the next edit nearby.
- **Not implemented:** greedy meshing (optional), wall-torch tilt, rain occlusion beyond the column top, and entity shadows.
- **Village radius:** the site radius (44) is a constant in `world/terrain.ts` (`VILLAGE_RADIUS`). If V2 needs a different size, that's a one-line edit there.

## Shared-file edits

None outside this repo. No Liveforge imports.
