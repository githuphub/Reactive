# Recipe: forge gear from a prompt

**Goal:** the player says *"a rusty cleaver that drips green fire"*. A cleaver appears in their hand straight
away, the AI version replaces it a moment later, and (optionally) a Hyper3D mesh swaps in when it is ready. Stats
always respect your item schema.

## Manifest

```yaml
elements: [physical, fire, ice, lightning, poison]
items:
  families: [dagger, sword, axe, hammer, spear, staff, bow, shield_small]
  slots: [weapon, offhand, head, chest]
  stats:
    damage: { min: 1, max: 100, default: 30 }
    speed:  { min: 1, max: 100, default: 50 }
    range:  { min: 1, max: 100, default: 30 }
  budget: [1.4, 1.6, 1.9, 2.2, 2.6]          # per rarity tier: sum of normalised stats
  tags: [Piercing, Lifesteal, Swift, Heavy]
  creativity: { max: 0.8, rawPowerPenalty: true }
clamps:
  forge: { maxParts: 24, maxPerMinPerPlayer: 6, meshJobs: true }   # meshJobs also needs HYPER3D_API_KEY
```

`rawPowerPenalty` is the Counterforge rule. "The strongest sword ever" comes out plain and weak, while a clever,
specific prompt earns its stats.

## Web

```ts
import { LiveEquipSlot } from "@liveforge/three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const hand = new LiveEquipSlot({
  client: lf, socket: rightHandBone, slot: "weapon", length: 1.1,
  loadMesh: (url, headers) => { loader.setRequestHeader(headers); return loader.loadAsync(url).then((g) => g.scene); },
});
hand.on("equipped", (item) => hud.showItem(item));     // instant blueprint: about 10 ms
hand.on("upgraded", (item) => hud.showItem(item));     // AI version
hand.on("mesh", () => toast("Mesh ready"));            // Hyper3D GLB replaced the blueprint

hand.forge("a rusty cleaver that drips green fire", { element: "poison" });
// each frame: hand.animate(t);
```

Doing it by hand with any renderer:

```ts
const a = lf.ask("forge.item", { prompt: "a rusty cleaver that drips green fire", mesh: true });
const { item } = (await a.instant).result;            // ForgedItem: name, flavor, stats, tags, blueprint, vfx?
scene.add(buildBlueprint(item.blueprint));             // @liveforge/three, or your own Blueprint v1 builder
if (item.vfx) scene.add(buildVfx(item.vfx));
a.onUpgrade((r) => swapItem(r.result.item));
lf.on("forge.ready", (d) => d.args.url && loadGlb(lf.resolveUrl(d.args.url)));
```

## Godot

```gdscript
var a := Liveforge.ask("forge.item", {"prompt": "a frost harpoon on a chain"})
a.answered.connect(func(r): $Hand/LiveEquipSlot.equip(r.item))   # LiveBlueprint + LiveVFX under the hood
a.upgraded.connect(func(r): $Hand/LiveEquipSlot.equip(r.item))
```

## Beyond items

| Ask | Result |
|---|---|
| `forge.armour_set {prompt, slots?}` | Matching pieces plus a set bonus. |
| `forge.look {prompt, asset}` | A **Variant** of *your* asset: material swaps, recolour, decals, part toggles. |
| `forge.vfx {prompt, attach?}` | A VFX recipe: emitters, trails, auras, lights. |
| `forge.creature`, `forge.prop`, `forge.npc_look` | Blueprints with stats and behaviour, or accessories. |
| `forge.loot {enemy, zone}` | Loot themed on the fight that just happened. |
| `forge.thing {prompt}` | Anything at all: decides whether it is a creature, food, tool, weapon, wearable, decoration, material or block, with a voxel model. See [Forge anything](../forge.md). |

## In the dashboard

| Panel | What you see |
|---|---|
| **Gallery** | Every forged result rendered live in 3D, with VFX, stats, tags, source (rules / cache / ai) and the prompt. |
| **Cost & latency** | `forge`: instant p95 in milliseconds next to upgrade latency and $. |
