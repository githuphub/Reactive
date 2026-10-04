# Forge anything (`forge.thing`)

`forge.item` makes gear: ask it for "a chicken" and you get a chicken-themed weapon. `forge.thing` is the forge
for everything else. It first decides what the prompt **is**: a creature, food, tool, weapon, wearable,
decoration, material or block. Then it makes that thing with a small coloured voxel model. "A chicken" comes back
as a white chicken with a red comb and wattle, a yellow beak and legs and small wings. It wanders about, clucks
and lays eggs.

```ts
const h = lf.forge.thing("a chicken");            // same as lf.ask("forge.thing", { prompt: "a chicken" })
spawnOrGive((await h.instant).result);             // keyword rules, in milliseconds
h.onUpgrade((r) => replace(r.result));             // Sonnet's version, a few seconds later
```

```
POST /v1/ask/forge.thing   { "world": "w1", "player": "p1", "params": { "prompt": "a chicken" } }
```

## Params

| Field | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | string (1–400) | required | What the player said. |
| `context` | object | none | Free game context (biome, who asks, what is nearby). It goes into the AI prompt only. |
| `categories` | `ThingCategory[]` | all | The allowed subset. Anything else is re-interpreted: a creature becomes a figurine decoration, and anything else becomes the first allowed category. |
| `maxModelSize` | int (4–32) | 16 | Max model size per axis, in voxels. |

## Result: `ForgedThing`

| Field | Notes |
|---|---|
| `id` | Deterministic: a slug of the name plus a short hash (`chicken_1x9k2a`). |
| `name`, `description`, `flavor` | `description` is one sentence; `flavor` is a short in-world line. |
| `rarity` | `common` \| `uncommon` \| `rare` \| `epic` \| `legendary` |
| `category` | `weapon` \| `tool` \| `food` \| `creature` \| `wearable` \| `decoration` \| `material` \| `block` |
| `model` | `VoxelModel` (below). |
| `stats` | `{damage, attackSpeed, miningSpeed, durability, food, saturation, armor, light, stackSize}`. Every field is a number, 0 when it does not apply. `stackSize` is at least 1. All are clamped to `THING_STAT_LIMITS`. |
| `effect` | `none`, `chain_lightning`, `fire_trail`, `vein_mine`, `knockback_burst`, `heal_aura`, `frost_slow`, `glow`, `speed`, `jump`, `night_vision`, `explode_on_hit` |
| `creature` | Set only when the category is `creature`, else `null`: `{behaviour, health, speed, size, parts?, sounds[], drops[], lays?, tameWith?}` (details below). |
| `wearable` | `{slot: head \| chest \| legs \| feet \| back}`, or `null`. |
| `recipe` | `{shape: ["XXX", " S ", " S "], key: {X: "iron_ingot", S: "stick"}}`, or `null`. |
| `tags` | Short lowercase words: the category, the template, the effect and the colours. |

The `creature` fields:

- `behaviour`: `passive`, `pet`, `hostile`, `neutral`, `flying`, `swimming` or `guard`.
- `health`: hit points.
- `speed`: blocks per second.
- `size`: world height in blocks. Scale the model so its height matches.
- `parts`: limb boxes in model voxels (`head`, `leg_left`, `wing_right`, `tail` …) for simple animation.
- `sounds`: onomatopoeia for speech bubbles.
- `drops`: item names (snake_case).
- `lays`: an item it produces now and then (`egg`).
- `tameWith`: the item that tames it.

### `VoxelModel`

```json
{ "size": [8, 10, 11], "pivot": [3.5, 0, 5],
  "palette": { "body": "#f4f4f0", "comb": "#d93b2b", "beak": "#f2c230", "eye": "#1c1c22" },
  "ops": [ { "op": "box", "from": [1, 3, 2], "to": [6, 6, 7], "block": "body" }, ... ] }
```

The ops are the same as in the [Voxel DSL](builder.md): `box`, `hollow_box`, `edges`, `line`, `cylinder`, `sphere`,
`fill_air`, `block`, `repeat`, `mirror` and so on. Here `block` names a **palette key**, so every voxel is a
colour.

- **Coordinates:** model voxels, `0..size-1` on each axis, with +Y up.
- **Held items** (weapons, tools, held food, materials): the grip is at the bottom and the item points up +Y. `pivot` is the grip.
- **Creatures:** face +Z, stand on y = 0 and are symmetric across x.
- **Wearables:** placement depends on `wearable.slot`. Head items rest on the head with their bottom at y = 0, centred, and `pivot` is the bottom centre.
- **Size limits:** every axis is at most `maxModelSize`. The model expands to between 8 and 4096 voxels.

Render a model with `expandVoxelModel(model)`, which returns `{voxels: [{x, y, z, color}], size}`. The voxels come
in build order (y ascending) with air removed. One cube per voxel is fine at this size. Merge faces if you want.

```ts
import { expandVoxelModel } from "@liveforge/sdk";        // or lf.forge.expand(model)
for (const v of expandVoxelModel(thing.model).voxels) addCube(v.x, v.y, v.z, v.color);
```

## How it decides

The instant answer comes from keyword rules (`rulesForgedThing`), with no LLM. This is also the offline answer:
the SDK runs the same rules locally when the server is unreachable.

- **The head noun wins.** "Chicken soup" is food. "A sword of fire" is a fire sword. "A lamp made of honey" is a lamp.
- **"X of Y" heads.** For "a statue of a chicken", "block of gold" and "potion of healing", the head decides the category and Y is the subject.
- **Living things become creatures.** Cooked ones ("roast chicken") become food. Plush and figurine versions become decorations shaped like the creature.
- **Categories:**
  - Creature, food, tool, weapon, wearable, decoration, material and block each have their own word list.
  - Nouns that match nothing become a decoration.
  - The weapon category is only chosen when weapon words appear.
- **Colour words** recolour the template ("a red chicken", "a golden apple"). Material words like iron, diamond and wooden count as colours. "Dark" and "light" shift the shade.
- **Effect and rarity words:**
  - Effect words set `effect` ("fire" → `fire_trail`, "frost" → `frost_slow`).
  - Rarity words set `rarity` ("golden" → rare, "enchanted" → epic, "legendary" → legendary).
- **Template models:** 96 creature species (several hundred words) built on 8 body plans (bird, quadruped, fish, bug, serpent, blob, biped, dragon) and 96 item templates: swords, bows, staffs, pickaxes, fruit, cake, bread, potions, hats, helmets, boots, capes, crates, lanterns, flowers, statues, gems, ingots, blocks and more.

The **upgrade** is one Sonnet call: tier `rich`, task `forge.thing`, structured output against
`forgedThingJsonSchema(categories)`. The system prompt teaches the Voxel DSL with two examples (an 8×9×10 chicken
and a 3×16×1 sword) and injects the manifest lore, tone and safety rules. The answer is clamped with
`clampForgedThing`. If the model does not expand to 8–4096 voxels, the upgrade returns null and the rules answer
stands. Name, description, flavour and sounds go through output moderation.

Other behaviour:

- **Cache:** upgraded answers are shared across players by normalised prompt ("A Chicken!" = "chicken"), plus `categories` and `maxModelSize`.
- **Event log and gallery:** every answer (rules and AI) is recorded as `lf.forge.created`. It shows in the dashboard **Gallery** as an isometric voxel render with category, rarity, effect, stats and creature info.
- **Brain feed:** every answer is pushed as source `forge`, kind `plan`, with the text "Forged Clucky Hen (creature)" and a model badge.
- **Fizzle and rate limit:** blocked prompts fizzle into "a lump of grey slag". The per-player rate limit is manifest `clamps.forge.maxPerMinPerPlayer`.

## Manifest

The ask belongs to the `forge` module (`modules.forge: true`). To use Sonnet for it, add the override:

```yaml
models:
  overrides:
    forge.thing: rich
```

## Protocol exports

These are exported from `@liveforge/protocol` and re-exported where noted.

- **Schemas and types:**
  - `ForgedThing`, `ForgeThingParams`, `VoxelModel`, `ThingCreature`, `ThingStats`, `ThingRecipe`, `ThingPart`.
  - The enum lists `THING_CATEGORIES`, `THING_RARITIES`, `THING_EFFECTS`, `THING_BEHAVIOURS`, `THING_SLOTS`, `THING_STAT_NAMES`.
  - The limits `THING_STAT_LIMITS` and `VOXEL_MODEL_LIMITS`.
- **Model helpers:** `expandVoxelModel(model)`, `clampVoxelModel(raw, {maxSize})` and `voxelModelJsonSchema()`. These three are re-exported by `@liveforge/sdk`.
- **AI answers:** `forgedThingJsonSchema(categories)` and `clampForgedThing(raw, opts)`.
- **Rules:** `rulesForgedThing({prompt, categories?, maxModelSize?})`, `analyzeThing(prompt)` and `normalizeThingPrompt(prompt)`. `rulesForgedThing` and `analyzeThing` are re-exported by `@liveforge/sdk`.
- **JSON Schemas:** `schema/v1/ForgedThing.json`, `VoxelModel.json`, `ask.forge.thing.params.json` / `.result.json`, and the LLM forms `VoxelModel.llm.json` and `ForgedThing.llm.json`.
