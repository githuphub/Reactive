# V1 report: Livecraft survival + mobs

Status: built on branch `V1` (worktree `F:/Development/Livecraft-V1`). `npm run typecheck` and `npm run build` pass. Per the user rule, I wrote and ran no tests and did no browser smoke, so nothing here has been seen running yet.

## Try it

```bash
npm install
npm run dev            # http://localhost:5180
```

- Fresh survival world: `?fresh` (empty inventory). Creative: `?creative` or press **G**.
- Night with mobs: `?time=night`. No natural spawns: `?peaceful`.
- Console: `window.mobs` (the mobs API) and `window.survival` (the survival API), e.g.
  `mobs.spawnWave({ mob: 'spider', count: 4, tactic: 'climb_pillar', spawn: 'north' })`,
  `survival.giveItem(game, 'bow')`, `survival.giveItem(game, 'arrow', 32)`.

| Input | Action |
|---|---|
| E | Inventory (2×2 crafting; a Creative tab with every item in creative) |
| RMB on crafting table / furnace / chest | 3×3 crafting / furnace / chest screens |
| In screens | LMB pick/place/swap, RMB half/one, drag to split (LMB even, RMB one each), Shift+click quick-move or craft-all, 1–9 swap with hotbar, Q drop (Ctrl+Q stack), click outside to throw |
| Q / Ctrl+Q | Drop one / the stack |
| Hold RMB with food | Eat (1.6 s) |
| Hold RMB with bow, release | Shoot (charge 1 s; full charge = crit) |
| G | Toggle creative / survival (also in the pause menu) |
| F7 | Path debug view (every mob's path, coloured by tactic; dig nodes orange) |
| RMB on TNT with flint or a torch | Prime TNT |

## What's built

### Survival (`src/survival/**`)
- **Items** (`items.ts`): bow (384 uses), arrow, leather, gunpowder, bone, rotten flesh, raw/cooked porkchop and beef, brick; original procedural icons. Registered at module load so saved inventories restore. Tools, coal, ingots, diamond, wheat, bread, apple, string, stick come from V0. `itemInfo(name)` gives tier, durability, damage and food. Harvest rules (stone needs a pickaxe, ores need tiers) are V0's `computeDrops`.
- **Recipes** (`recipes.ts`, `recipe-book.ts`): shaped (mirrored too) + shapeless, ingredients by name, `#tag` or alternatives. 24 recipe definitions expand to ~60 recipes: planks ×3, sticks, crafting table, chest, door, ladder, bookshelf, 25 tools (5 materials × pickaxe/axe/shovel/sword/hoe), shears, bow, arrows (feather or bone), torch, furnace, glow lamp, TNT, bricks, stone bricks, sandstone, white wool, storage blocks ↔ ingots, hay bale ↔ wheat, bread.
- **Furnace-lite** (`containers.ts`): fuel + input → output, 4 s per item; ores → ingots, sand → glass, raw meat → cooked, cobblestone → stone, clay → 4 bricks, logs → coal, cactus → green wool. Fuels: coal 40 s, planks/logs 7.5 s, sticks, saplings, wooden tools, hay. Keeps smelting with the screen closed; flame and smoke particles.
- **Chests**: 27 slots per position. Chest and furnace state live in the `containers` save slot. Breaking or blowing one up drops its contents.
- **Inventory UI** (`ui/container-screen.ts`, `ui/screens.ts`): the 36-slot V0 inventory with cursor stacks, drag split, shift-click, hotbar swap, tooltips (name, durability, damage, food), and a searchable creative palette.
- **Health and hunger** (`health.ts`): 20 hp, 20 hunger, saturation and exhaustion (sprint, jump, swim, attacks, damage). Regeneration when hunger ≥ 18 (fast when full and saturated), starvation at 0 (down to half a heart), no sprinting at hunger ≤ 6. Fall damage, drowning (15 s of air, bubbles), lava, burning, cactus. Hurt cooldown with "stronger hit applies the difference". Saved in the `survival` slot.
- **HUD** (`hud.ts`): hearts (shake when low, flash when hit), hunger, air bubbles, red hurt vignette, fire overlay, an attack / bow / eating meter under the crosshair, and the death screen (cause of death + Respawn).
- **Death**: the inventory drops as item entities, then you respawn at the spawn point with full stats.
- **Item entities** (`item-drops.ts`): spinning mini cubes (blocks) or sprites, gravity, bob, a pickup magnet, stack merging, a 5 min lifetime (blinking at the end), lit by local light. Broken blocks drop items (`player` in survival, `support`, `explosion` sources); mobs drop loot.
- **Combat** (`combat.ts`): melee damage by item with attack strength (cooldown per weapon), falling crits (×1.5 + sparks), knockback and a sprint-hit bonus, tool wear. Bow: draw, release, physical arrow, arrow use, pick-up of your stuck arrows. Eating with crumbs.
- **Creative**: G or the pause menu. Fly, instant break, no damage, infinite blocks (`inventory.infinite`), Creative tab.
- **Play-style detectors** (`detectors.ts`): `pillared {height}` and `hid {depth}`.

### Mobs (`src/mobs/**`)
- **Models** (`models.ts`): original box models with canvas-painted skins: zombie (+ baby, + shield), skeleton (ribs, bow), creeper (our own leaf-mottled design with slit eyes), spider (8 legs, amber eyes), pig, cow. Limb swing (humanoid, quadruped, spider gait), hurt flash, knockback, a tip-over + puff death animation, burning particles.
- **Behaviours**: zombie (melee, burns in daylight unless shaded, fast `baby_zombie`, optional `shield` blocking 75% of frontal melee and all frontal arrows), skeleton (holds 6–13 blocks, strafes, draws, shoots leading, arcing arrows when it can see you), creeper (1.5 s fuse when within ~3 blocks with line of sight, swelling and white blinking, defuses if you get away; explosion r = 3), spider (climbs any wall, leaps, neutral in daylight unless provoked), pig and cow (wander, graze, follow a player holding wheat or an apple, panic when hit; drops are cooked if the animal died burning). Hostiles also hunt `PREY_TYPES` (default `villager`) and retaliate against attackers (golems).
- **Pathfinding** (`pathfind.ts`, `brain.ts`): grid A* over voxels (walkable = solid below + body-height air), step up 1, drop ≤ 3, diagonals without corner cutting, ladders, swimming, optional wall climbing, doors and digging. Node limit, partial paths to the closest reachable node, time-sliced (2.5 ms per frame shared by all mobs), cached (2 s, invalidated by nearby block changes), and repath when the goal moves or a block changes near the path. MobBrain also detects being stuck, jumps, opens doors (`doors: true`) and turns smoothly.
- **Spawning** (`spawner.ts`): hostiles at night or in the dark (light ≤ 7) 24–64 blocks away on the surface and in caves, in packs, cap 22. Animals on grass in daylight, cap 10, and a few seeded near spawn on `ready`. Natural mobs despawn beyond 96 blocks (and randomly beyond 40).
- **Explosions** (`explosion.ts`): a sphere with per-block resistance (bedrock and obsidian survive), 30% debris drops, line-of-sight damage + knockback, TNT chain-priming, flash sphere + point light + smoke/fire/debris particles.
- **Arrows** (`projectile.ts`): gravity + drag, block sticking, entity and player hits, crit trails, ballistic `aimArrow`.

## API for V2 / V3

### Mobs (`import { … } from '../mobs'`)

```ts
spawnMob(type, pos, opts?) → Mob | null
// type: 'zombie' | 'baby_zombie' | 'skeleton' | 'creeper' | 'spider' | 'pig' | 'cow' | registered
// opts: { tactic?, target?: 'player' | Entity | null, shield?, persistent? (default true),
//         fireproof?, health?, speed? (multiplier), followRange?, reason?, data? }

spawnWave({ mob, count?, tactic?, spawn?, center?, radius?, target?, options? }) → Mob[]
// spawn: 'ring' (default) | 'near' | 'far' | 'random' | 'north' | 'south' | 'east' | 'west' | {x,y,z}
// Waves default to target 'player', fireproof, persistent. Shaped like faction.raid_plan waves.

getSpawnDirector(game)        // SpawnDirector
  .naturalSpawning = false     // clean stage for a raid
  .hostileCap / .animalCap / .minDistance / .maxDistance / .despawnDistance
  .onNaturalSpawn((ctx) => false | void)  // veto or edit ctx.type (e.g. no spawns inside the village)
  .mobs() / .count(type?, near?, r?) / .clear(filter?) / .findSpot(x, z, fromY?)
  .seedAnimals(n)

// Tactics (mob.tactic, or opts.tactic):
'climb_pillar' | 'tunnel' | 'keep_distance' | 'rush' | 'flank' | 'rooftops'
registerTactic(name, { path?, speed?, range?, goal(ctx)?, act(ctx, input)? })  // add your own
mob.setTactic(name | null); mob.setTarget('player' | entity | null)
```

| Tactic | Behaviour |
|---|---|
| `climb_pillar` | Wall-climbing paths for every mob; zombies/skeletons build up under a target that's high above them (`buildUp`). |
| `tunnel` | Paths through soft blocks (hardness ≤ 2.5, never bedrock/obsidian/doors/chests); the mob digs each cell (time by hardness, particles). |
| `keep_distance` | Skeletons hold 11–17 blocks; melee mobs circle at ~6 and lunge every few seconds. |
| `rush` | ×1.35 speed, greedy paths; skeletons close to 1.5–5. |
| `flank` | Swings wide to approach from the side (left/right by mob id). |
| `rooftops` | Seeks the highest standable spot near the target (roofs, hills) and builds up if stuck below it; skeletons snipe from there. |

```ts
pathfind(from, to, opts?) → Path | null                 // sync, bound to the game
findPath(world, from, to, opts?)                         // sync, any world
getPathfinder(game).request(from, to, opts) → PathRequest // time-sliced: .done/.result/.promise
// PathOptions: maxNodes 2500, range 1, height 2, maxDrop 3, jump, ladders, climb, doors, swim,
//              dig, digMaxHardness 2.5, diagonal, partial, greed 1.4
// Path: { nodes: {x,y,z,move,dig?}[], complete, cost, expanded }

new MobBrain(entity, { speed?, path?, repathInterval?, arriveDistance?, turnRate?, onDig? })
  .moveTo(x, y, z, { speed? })   // cheap every frame
  .update(dt) → StepInput        // pass to entity.move(dt, input)
  .stop() / .repath() / .arrived / .state / .lookTarget / .path / .remaining / .dispose()
// Steering: seek, flee, strafe, separate, hasLineOfSight, yawTo, turnTowards

explode(game, x, y, z, { radius?, power?, breakBlocks?, dropChance?, byEntity?, source?, maxDamage? })
primeTnt(game, x, y, z, fuse?)
shootArrow(game, { from, velocity, damage, shooter, crit?, pickup?, item? }); aimArrow(from, to, speed)
registerMobType(type, (opts) => new MyMob()); createMob(type, opts); mobTypes()
PREY_TYPES.add('trader')   // what hostiles hunt besides the player
```

`Mob extends Entity` fields: `type`, `category` ('hostile' | 'animal'), `tactic`, `target`, `brain`, `model`, `persistent`, `natural`, `shield`, `fireproof`, `speedMul`, `followRange`, `burning`.

### Survival (`import { … } from '../survival'`)

```ts
registerRecipe({ id?, pattern: ['GDG', ' S ', ' S '], key: { G: 'gold_ingot', D: 'diamond', S: 'stick' }, result: { item, count?, data? } })
registerRecipe({ id?, ingredients: ['bone', '#planks'], result })          // shapeless
unregisterRecipe(id); allRecipes(); recipesFor(item); matchRecipe(grid, size); onRecipeRegistered(cb)
registerSmelting({ input, output, count?, time? }); registerFuel(itemOrTag, seconds); smeltingFor(stack); fuelTime(stack)

giveItem(game, item | stack, count = 1, { dropOverflow = true }) → given
takeItem(game, item, count = 1) → boolean   // all or nothing
hasItem(game, item, count = 1); countItem(game, item); throwFromPlayer(game, stack)
// game.inventory itself: add/remove/count/get/set/selectedStack (V0)

getHealth(game)  // .health .hunger .saturation .air .burning .dead .keepInventory
                 // .hurt(n, source) .heal(n) .feed(h, s) .exhaust(n) .kill(cause) .respawn()
hurtPlayer(game, amount, { kind, entity?, knockback? })
dropItem(game, stack, pos, { velocity?, pickupDelay? }); dropItems(game, stacks, pos)
getContainers(game).chest(x,y,z) / .furnace(x,y,z) / .get(x,y,z) / .changed()
getParticles(game).burst({ x, y, z, count, color, speed, up, life, size, gravity, spread })
itemInfo(name) → { tier, durability, damage, food, saturation, maxStack, isBlock }
```

### Game events added (typed through declaration merging in `survival/events.ts`)

| Event | Payload |
|---|---|
| `playerHurt` | `{ amount, health, source: DamageSource }`. `source.kind`: melee, arrow, explosion, fall, lava, fire, drown, starve, cactus. `source.entity` is the attacker. |
| `playerStatsChanged` | `{ health, hunger, saturation, air }` |
| `playerDied` | `{ cause, source, x, y, z }` (cause is a readable line, e.g. "Shot by a skeleton") |
| `playerAte` | `{ item, hunger, saturation }` |
| `playerShotBow` | `{ charge 0..1, damage, target: Entity \| null }` |
| `itemCrafted` | `{ item, count, recipe, station: 'inventory' \| 'crafting_table' }` |
| `itemSmelted` | `{ input, item, count, x, y, z }` |
| `itemPickedUp` | `{ item, count }` |
| `mobKilled` | `{ mob, type, byPlayer, source, tactic }` |
| `mobSpawned` | `{ mob, type, reason: 'natural' \| 'director' \| custom, tactic }` |
| `explosion` | `{ x, y, z, radius, source, blocks }` |
| `pillared` | `{ height, x, y, z }`: standing on a self-built free-standing 1×1 column ≥ 4 high (re-fires when it grows) |
| `hid` | `{ depth, x, y, z }`: at dusk/night, no sky light at the head, ≥ 2 blocks of ground above and walls within 4 blocks on all sides (max once per 60 s) |

V0 events still apply (`entityHurt`, `entityDied`, `blockBroken` with `source: 'explosion' | 'entity'`, ...). Mob-dug blocks are `source: 'entity'` with `entity` set; creeper/TNT craters are `source: 'explosion'`.

## Shared-file edits (V0)

- `src/player/player.ts`: added `canSprint = true` and `|| !this.canSprint` to the sprint-cancel condition (2 lines). Hunger ≤ 6 disables sprinting.
- Deleted `src/mobs/.gitkeep`.

No other V0 files changed. New events use declaration merging rather than editing `game/events.ts`. No Liveforge imports.

## Gaps and concerns

- **Never run.** Typecheck + build only. The riskiest parts:
  - Path following feel: node-reach thresholds, jump timing and stuck recovery are tuned by reasoning only.
  - Tactic tuning: `buildUp` jump/place timing, rooftop spot choice, tunnel dig speed.
  - Box-model limb orientations (spider leg spread, zombie shield, skeleton bow).
  - UI layout and drag/split edge cases.
- **Mobs aren't saved.** Natural mobs respawn by rules. Raid mobs vanish on reload.
- **Not done (optional items):** armour, XP orbs, recipe book, sounds, eating animation beyond arm bobs and crumbs, mob head tracking.
- **Furnaces** don't get a lit texture or light while burning (particles only).
- **Pathfinding ignores body width:** wide mobs (spider ≈ 1 block, cow 0.9) can clip corners slightly. Diagonal moves need both side cells free, which hides most of this.
- **Doors:** open doors count as passable for `doors: true` paths, but their thin collision box can still block an entity at a bad angle.
- **Natural hostiles hunt villagers** (`PREY_TYPES` = `villager`). If V2's villager type name differs, add it to `PREY_TYPES`. Remove `'villager'` to make villages safe. V2 can also veto spawns inside the village with `getSpawnDirector(game).onNaturalSpawn`.
- **Mob spawn/despawn and item drops are main-thread work.** Caps keep the cost small, but they haven't been profiled.
