# Builder and the Voxel DSL

`builder.plan` turns a prompt into a **Voxel DSL** plan. The plan is a compact JSON list of shape ops. Any engine
expands it into an ordered block list with `expandVoxelPlan`, which is pure TypeScript in `@liveforge/protocol` and
re-exported by `@liveforge/sdk`.

- **Instant:** a parametric template sized to the site.
- **Upgrade:** a Sonnet-designed plan, using structured output against `voxelPlanJsonSchema()`, clamped and checked.

## Turn it on

```yaml
modules:
  builder: true

builder:
  palette: [oak_planks, spruce_log, bricks, cobblestone, glass, torch]   # wall, trim, roof, floor, glass, accent
  blockIds: [grass, dirt, stone, cobblestone, oak_log, oak_planks, spruce_log, spruce_planks, glass, bricks, stone_bricks, torch, door, white_wool, red_wool, blue_wool, yellow_wool, farmland, wheat, water, sand, hay]
  aliases: { thatch: hay }   # extra word -> block id for AI plans
  maxBlocks: 4000
  styleGuide: "Villagers build low, wide cottages with steep roofs."
```

`blockIds` is optional. When set, every plan is mapped onto those ids. The mapping tries, in order: your aliases,
the built-in aliases, plural and `_block` variants, then name similarity, and finally the fallback block.

## Ask

```ts
const h = lf.builder.plan({
  prompt: "a cosy house with a tower",
  site: { size: [16, 14, 10], ground: "grass" },  // x (width), y (height budget), z (depth)
  palette: ["oak_planks", "spruce_log", "bricks"], // optional, by role; statues: colours [shirt, trousers, skin, hair]
  style: "rustic",
  npc: "bram",                                     // persona voice + lore in the AI prompt
  context: "next to the village well",
});
const first = (await h.instant).result;   // {plan, summary, materials, template}
h.onUpgrade((r) => rebuildWith(r.result.plan));

const { blocks, materials, bounds, warnings } = lf.builder.expand(first.plan, { site: [16, 14, 10], origin: [px, py, pz] });
for (const b of blocks) world.setBlock(b.x, b.y, b.z, b.block);   // bottom-up, structure before details
```

- **Result:** `{plan: VoxelPlan, summary, materials: {block: count}, template?}`. `template` is set only on rules
  answers.
- **Instant:** the keyword-picked template (`house`, `tower`, `wall`, `statue`, `bridge`, `farm`, `well`; default
  `house`). "house with a tower" on a site at least 13 wide combines both.
  - **Palette:** from `palette`, then the manifest's `builder.palette`, then material words in the prompt ("stone
    tower").
- **Upgrade:** `ctx.llm.json(voxelPlanJsonSchema(), ...)` on the `rich` tier (task `builder.plan`, about 2500 output
  tokens, 40 s timeout). It is clamped to the site and limits and expanded to count materials. A plan with 0 blocks
  is rejected, and the template stays.
  - The name and summary are moderated.
  - The cache key is prompt + site + palette + style, kept for 24 h.
- **Records:** every plan is recorded as `lf.builder.planned {npc, prompt, plan, summary, source, template, materials}`
  and pushed to the Brain feed (`source: "builder"`, `kind: "plan"`).
- **Offline:** without a server, the SDK answers from the same template planner (`localBuilderPlan`). Call
  `lf.builder.setBlockIds(ids)` so local plans use your block ids.
- **Module options** (`modules.builder: {options: {maxTokens, timeoutMs}}`) tune the AI call.

## Voxel DSL v1

```json
{ "name": "Cosy tower house", "palette": {"wall": "oak_planks", "trim": "spruce_log", "roof": "bricks"},
  "ops": [
    {"op": "hollow_box", "from": [0,0,0], "to": [6,4,5], "block": "wall"},
    {"op": "edges", "from": [0,0,0], "to": [6,4,5], "block": "trim"},
    {"op": "roof", "style": "gable", "from": [-1,5,-1], "to": [7,5,6], "block": "roof"},
    {"op": "cylinder", "center": [9,0,2], "radius": 2, "height": 8, "hollow": true, "block": "stone_bricks"},
    {"op": "door", "at": [3,1,0], "facing": "north"},
    {"op": "repeat", "count": 3, "step": [2,0,0], "ops": [{"op": "window", "at": [1,2,0], "block": "glass"}]}
  ] }
```

**Coordinates** are integers relative to the site origin. `y = 0` is ground level, the floor layer. Axes: +x east,
+z south, +y up. North is -z, so the front of a building usually faces north. Box corners are inclusive and may come
in any order. `block` is a palette key or a block id.

| Op | Fields | Makes |
|---|---|---|
| `box` | `from`, `to`, `block` | Solid box |
| `hollow_box` | `from`, `to`, `block` | The box's shell, including floor and ceiling |
| `edges` | `from`, `to`, `block` | The 12 edges (frames, trim, a farm border on a 1-high box) |
| `line` | `from`, `to`, `block` | Straight 3D line |
| `cylinder` | `center`, `radius`, `height`, `hollow?`, `block` | Vertical cylinder standing on `center`; `hollow` = walls only |
| `sphere` | `center`, `radius`, `hollow?`, `block` | Ball or shell |
| `roof` | `style` (`gable`, `hip`, `flat`), `from`, `to`, `block`, `axis?` (`x`, `z`) | Roof over the footprint, starting at `from.y` |
| `door` | `at`, `facing?`, `block?` (default `door`) | Clears a 2-tall opening and puts the door in the lower half |
| `window` | `at`, `block?` (default `glass`) | One window block |
| `stairs` | `from`, `to`, `block` | One step per layer along the longer horizontal axis; the other axis is the width |
| `fill_air` | `from`, `to` | Clears a box (interiors, doorways, terrain) |
| `block` | `at`, `block` | One block (torch, chest ...); a Reactive addition to the spec |
| `repeat` | `count`, `step`, `ops` | `ops` `count` times, each copy offset by `step * i` |
| `mirror` | `axis` (`x`, `z`), `at`, `ops` | `ops` plus a copy mirrored across the plane `axis = at` (`x' = 2*at - x`; `.5` planes for even widths) |

**Roofs.** Gable puts the slopes on the long sides, with the ridge along the longer axis unless `axis` is given. The
end triangles are filled. Hip is a stack of shrinking rings. Flat is the from-to box.

**Facing** is north, south, east or west. A door's facing is the side it opens toward. A stair's facing is the
direction you walk to go up.

### Limits (clampVoxelPlan)

| Limit | Value |
|---|---|
| Op nodes | 60 (repeat / mirror and their children each count) |
| Primitive ops after expansion | 200 |
| Non-air blocks | 4000 (or `builder.maxBlocks`); trailing ops are dropped until the plan fits |
| `repeat.count` | 32 |
| Radius | 24 |
| Nesting | One level (a repeat may hold a mirror whose ops are primitives) |

With a site, coordinates are clamped into `0..size-1`, which trims box ops to the plot.

`clampVoxelPlan(raw, {maxOps, maxExpandedOps, maxBlocks, site})` accepts untrusted JSON in the form above, in the
flat structured-output form (every field present, `null` when unused, palette as `[{key, block}]`), or as a JSON
string. It never throws. It also understands a few aliases (`cube`, `fill`, `air`, `torch`, `stair` ...).

### Expansion (expandVoxelPlan)

`expandVoxelPlan(plan, {site?, origin?, blockIds?, aliases?, fallback?, maxBlocks?})` returns
`{blocks: [{x, y, z, block, facing?}], materials, bounds: {min, max}, warnings}`.

- **Deterministic.** The same plan and options always give the same list.
- **De-duplicated.** When ops overlap, the last write wins.
- **Ordered** for building bottom-up: by layer (y ascending), then structure, then details (doors, windows, stairs,
  torches, ladders), then `air` (cells to clear). Within a group, the order is write order.
- **`site`** drops blocks outside the plot, and **`origin`** shifts the output to world coordinates.
- **`materials`** counts every block except air.
- **`warnings`** lists the id mappings, the clipped blocks and any truncation.

## Templates

`VOXEL_TEMPLATES` are parametric rules plans. `voxelTemplateFor(name, {size, palette, colors})` sizes one to a site.
`rulesVoxelPlan({prompt, size, palette})` is the builder's instant answer.

| Template | Signature | Notes |
|---|---|---|
| `house` | `house(w = 7, d = 6, h = 4, palette)` | Walls, trim edges, cleared interior, gable roof with a 1-block overhang (occupies w+2 x d+2), door, windows, torches |
| `tower` | `tower(w = 5, h = 10, palette)` | Round stone tower, floors, battlements with crenels, door, windows every 3 layers |
| `wall` | `wall(length = 9, h = 4, palette)` | 2-thick wall with crenellations and a gate when 7+ long |
| `statue` | `statue(colors = [], scale = 2, palette)` | Blocky humanoid on a plinth (torso 2x3x1 units); colours `[shirt, trousers, skin, hair]` as block ids or `#rrggbb` (mapped to the nearest wool via `colorToBlock`) |
| `bridge` | `bridge(length = 9, w = 3, palette)` | Plank deck, log rails, torches every 4 blocks |
| `farm` | `farm(w = 9, d = 9, palette)` | Log border, farmland, a water channel, wheat, corner torches |
| `well` | `well(palette)` | 5x5 cobblestone well with water, posts and a roof |

**Palette roles:** `wall`, `trim`, `roof`, `floor`, `glass`, `accent`. Templates add their own: `stone` (towers and
walls), `soil`, `crop` and `water` (farms), `base`, `shirt`, `trousers`, `skin`, `hair` and `eyes` (statues).

## AI prompt

The system prompt teaches the DSL with two compact examples, a house and a tower. It adds the lore, tone and safety
rules, the game's `blockIds` and the `styleGuide`. It depends only on the manifest, so prompt caching works. The user
message carries the prompt, the site bounds, the preferred blocks, the style, the builder's persona, the context
and the block budget. `voxelPlanJsonSchema()` is also emitted as `packages/protocol/schema/v1/VoxelPlan.llm.json`.
