// forge.thing ("forge anything"): the forge decides what the prompt *is* and makes it, model included.
//  - instant: protocol rulesForgedThing (keyword category, head noun wins; colour words -> palette; template voxel
//    models per category: a chicken is a white bird with a red comb and wattle, never a weapon).
//  - upgrade: Sonnet (tier rich, task forge.thing) with structured output (forgedThingJsonSchema), clamped with
//    clampForgedThing; a model outside 8..4096 voxels returns null (the rules answer stands). Text is moderated.
// Every answer is recorded as lf.forge.created (forge.gallery) and pushed to the Brain feed ("Forged X (category)").
import {
  THING_CATEGORIES, THING_EFFECTS, THING_STAT_LIMITS, VOXEL_OPS, brainModel, clampForgedThing, expandVoxelModel, forgedThingJsonSchema,
  normalizeThingPrompt, rulesForgedThing, type AskParams, type BrainModel, type ForgedThing, type ThingCategory,
} from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { AskContext, AskHandler } from "../../module.js";
import { loreBlock, safetyBlock } from "../agents/lore.js";
import { overRate } from "./asks.js";
import { forgeEnv } from "./env.js";

type Params = AskParams<"forge.thing">;

const MAX_TOKENS = 3000;
const TIMEOUT_MS = 45_000;
const FIZZLE = "a lump of grey slag";

const EXAMPLE_CHICKEN = `{"category":"creature","name":"Clucky Hen","description":"A plump white hen that wanders the yard and lays eggs.","flavor":"\\"Bawk!\\" she says, with great conviction.","rarity":"common","effect":"none",
 "stats":{"damage":0,"attackSpeed":0,"miningSpeed":0,"durability":0,"food":0,"saturation":0,"armor":0,"light":0,"stackSize":1},
 "creature":{"behaviour":"passive","health":4,"speed":2.5,"size":0.7,"sounds":["bawk!","cluck cluck"],"drops":["feather","raw_chicken"],"lays":"egg","tameWith":"wheat_seeds",
  "parts":[{"name":"head","from":[2,5,6],"to":[5,8,9]},{"name":"leg_left","from":[2,0,4],"to":[2,1,4]},{"name":"leg_right","from":[5,0,4],"to":[5,1,4]},{"name":"wing_left","from":[0,3,3],"to":[0,5,5]},{"name":"wing_right","from":[7,3,3],"to":[7,5,5]}]},
 "wearable":null,"recipe":null,"tags":["farm","bird"],
 "model":{"size":[8,9,10],"pivot":[3.5,0,5],
  "palette":[{"key":"body","color":"#f4f4f0"},{"key":"red","color":"#d93b2b"},{"key":"yellow","color":"#f2c230"},{"key":"eye","color":"#1c1c22"}],
  "ops":[{"op":"mirror","axis":"x","at":3.5,"ops":[{"op":"line","from":[2,0,4],"to":[2,1,4],"block":"yellow"},{"op":"box","from":[0,3,3],"to":[0,5,5],"block":"body"},{"op":"block","at":[2,7,8],"block":"eye"}]},
   {"op":"box","from":[1,2,2],"to":[6,5,6],"block":"body"},
   {"op":"box","from":[2,4,0],"to":[5,6,1],"block":"body"},
   {"op":"box","from":[2,5,6],"to":[5,7,8],"block":"body"},
   {"op":"box","from":[3,6,9],"to":[4,6,9],"block":"yellow"},
   {"op":"box","from":[3,5,9],"to":[4,5,9],"block":"red"},
   {"op":"box","from":[3,8,7],"to":[4,8,8],"block":"red"}]}}`;

const EXAMPLE_SWORD = `{"category":"weapon","name":"Iron Sword", ... ,"model":{"size":[3,16,1],"pivot":[1,1,0],
  "palette":[{"key":"blade","color":"#d8dde4"},{"key":"guard","color":"#c9a23a"},{"key":"grip","color":"#5a3a24"}],
  "ops":[{"op":"line","from":[1,0,0],"to":[1,3,0],"block":"grip"},{"op":"box","from":[0,4,0],"to":[2,4,0],"block":"guard"},
   {"op":"line","from":[1,5,0],"to":[1,15,0],"block":"blade"},{"op":"line","from":[0,6,0],"to":[0,13,0],"block":"blade"},{"op":"line","from":[2,6,0],"to":[2,13,0],"block":"blade"}]}}`;

/** Stable system prompt (manifest-dependent only, so prompt caching works). */
export function thingSystem(m: Manifest): string {
  const stats = Object.entries(THING_STAT_LIMITS).map(([k, l]) => `${k} ${l.min}-${l.max}`).join(", ");
  return [
    `You are the forge of "${m.game.name}". A player names anything and you make exactly that thing: decide what it IS, then design it, including a small coloured voxel model.`,
    "",
    "Deciding what it is:",
    "- Respect the player's words literally; interpret them playfully but faithfully. \"a chicken\" is a chicken (a creature), never a sword or a chicken-themed weapon.",
    "- A living thing (animal, monster, person, spirit, robot pet) -> creature. Something edible or drinkable -> food. Swords, bows, wands -> weapon. Pickaxes, axes, rods, torches -> tool.",
    "  Clothes, hats, armour, capes, jewellery -> wearable (pick its slot). Furniture, statues, lamps, plants, ornaments -> decoration. Ingots, gems, dust, feathers, crafting ingredients -> material.",
    "  \"block of X\" or a placeable cube -> block. Only pick weapon when the words ask for a weapon. Use only the allowed categories; if the thing is not allowed, make the closest allowed version (a creature becomes a figurine decoration).",
    "",
    "The model (Voxel DSL; coordinates are integers in model voxels, 0..size-1 on each axis, y up):",
    `- Ops: ${VOXEL_OPS.join(", ")}. Useful here: box / hollow_box / edges / line / fill_air (from, to; corners inclusive), cylinder (center = bottom centre, radius, height; vertical), sphere (center, radius), block (one voxel at), repeat (count, step, ops), mirror (axis x|z, at = plane coordinate, .5 allowed; adds a mirrored copy of ops). Later ops overwrite earlier ones; fill_air carves.`,
    "- `block` is always a palette key. palette: 3-8 entries {key, color \"#rrggbb\"}.",
    "- Every op object in your answer carries every field; set the ones an op does not use to null. Ops inside repeat/mirror cannot nest again.",
    "- Orientation: held items (weapons, tools, held food, materials) have the grip at the bottom and point up +Y, thin along z; set pivot to the grip.",
    "  Creatures face +Z (head at high z) and stand on y = 0, symmetric across x (mirror axis x at (size.x-1)/2); give them eyes. Wearables: head items rest on the head with their bottom at y = 0, centred; chest / legs / feet / back items are shaped like the garment.",
    "- Size: every axis <= maxModelSize (from the request). The model must expand to 8-4096 voxels; aim for 60-600. Broad, readable silhouettes with a few contrasting details (beak, comb, eyes, guard, gem) beat noise.",
    "",
    "The rest:",
    `- stats: every field, 0 when not applicable (stackSize >= 1: 1 for weapons, tools, wearables, creatures; 16-64 otherwise). Ranges: ${stats}.`,
    `- effect: one of ${THING_EFFECTS.join(", ")}; "none" unless the words imply one.`,
    "- rarity: plain requests are common; reserve epic / legendary for genuinely special requests. Never inflate power because the player asks for \"the strongest\".",
    "- creature: only for category creature, else null. behaviour, health 1-1000, speed in blocks/s, size = world height in blocks, parts = limb boxes inside the model (head, legs, wings, tail) for simple animation,",
    "  sounds = short onomatopoeia for speech bubbles, drops = snake_case item names, lays = an item it produces now and then (or \"\"), tameWith = the taming item (or \"\").",
    "- wearable: {slot: head|chest|legs|feet|back} only for wearables, else null. recipe: 3 strings of 3 characters (space = empty) plus key [{char, item}], or null for creatures and things found in the world.",
    "- name <= 40 characters, description one sentence, flavor one short in-world line. tags: 1-6 short lowercase words.",
    "",
    "Example (\"a chicken\", maxModelSize 16):",
    EXAMPLE_CHICKEN,
    "",
    "Example model only (\"an iron sword\"):",
    EXAMPLE_SWORD,
    "",
    loreBlock(m, 2500),
    "",
    "Rules:",
    safetyBlock(m),
    "- If a request is not allowed, forge a harmless in-world substitute instead of refusing.",
  ].filter((l) => l !== "").join("\n");
}

/** Per-request user message. */
export function thingUser(p: Params, instant: ForgedThing, cats: readonly ThingCategory[]): string {
  return JSON.stringify({
    request: p.prompt,
    allowedCategories: cats,
    maxModelSize: p.maxModelSize,
    context: p.context ?? null,
    keywordGuess: { category: instant.category, name: instant.name, tags: instant.tags.slice(0, 3) },
    note: "keywordGuess is the offline fallback; use your own judgement.",
  });
}

function record(ctx: AskContext, p: Params, thing: ForgedThing, source: "rules" | "ai", model: BrainModel, ms?: number): void {
  ctx.record("lf.forge.created", { askKind: "forge.thing", askId: ctx.askId, result: thing, source, key: p.prompt.slice(0, 200) });
  ctx.brain({
    source: "forge",
    actor: "forge",
    kind: "plan",
    text: `Forged ${thing.name} (${thing.category})`,
    data: { prompt: p.prompt, id: thing.id, category: thing.category, rarity: thing.rarity, effect: thing.effect, size: thing.model.size },
    model,
    ...(ms !== undefined ? { ms } : {}),
    ref: ctx.askId,
  });
}

export const forgeThing: AskHandler<"forge.thing"> = {
  async instant(ctx, params) {
    const env = forgeEnv(ctx.manifest, ctx.options);
    const p: Params = { ...params };
    const notes: string[] = [];
    let final = false;
    const v = await ctx.moderation.check(p.prompt, { direction: "input", manifest: ctx.manifest });
    if (!v.ok) {
      // Counterforge's fizzle rule: blocked wishes forge something harmless, never an error
      p.prompt = FIZZLE;
      final = true;
      notes.push(`fizzled (${v.reason ?? "moderated"})`);
    }
    if (overRate(ctx, env)) {
      final = true;
      notes.push(`rate limit ${env.manifest.clamps.forge.maxPerMinPerPlayer}/min: rules only`);
    }
    const thing = rulesForgedThing({ prompt: p.prompt, categories: p.categories, maxModelSize: p.maxModelSize });
    record(ctx, p, thing, "rules", "rules");
    const n = expandVoxelModel(thing.model).voxels.length;
    const why = `keyword forge: ${thing.category} (${thing.tags[1] ?? thing.category}), ${thing.model.size.join("x")} model, ${n} voxels`;
    return { result: thing, why: [why, ...notes].join("; ").slice(0, 300), source: "rules", final };
  },

  async upgrade(ctx, p, instant) {
    if (!ctx.llm) return null;
    const m = ctx.manifest;
    const cats = p.categories?.length ? [...new Set(p.categories)] : [...THING_CATEGORIES];
    const r = await ctx.llm.json(forgedThingJsonSchema(cats), thingSystem(m), thingUser(p, instant, cats), {
      tier: "rich", task: "forge.thing", maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, signal: ctx.signal, player: ctx.player,
    });
    const thing = clampForgedThing(r.value, { prompt: p.prompt, maxModelSize: p.maxModelSize, categories: cats, fallback: instant });
    if (!thing) {
      ctx.log.info("AI forge.thing model unusable (needs 8-4096 voxels); keeping the rules answer", { prompt: p.prompt });
      return null;
    }
    // LLM text out: moderate the visible text, fall back to the rules wording when flagged
    const text = [thing.name, thing.description, thing.flavor, ...(thing.creature?.sounds ?? [])].join(" | ");
    const mod = await ctx.moderation.check(text, { direction: "output", manifest: m });
    if (!mod.ok) {
      thing.name = instant.name;
      thing.description = instant.description;
      thing.flavor = instant.flavor;
      if (thing.creature) thing.creature.sounds = instant.creature?.sounds ?? [];
    }
    record(ctx, p, thing, "ai", brainModel(r.model, (r as { source?: string }).source), r.ms);
    const n = expandVoxelModel(thing.model).voxels.length;
    return { result: thing, why: `AI forge: ${thing.category}, ${thing.rarity}, ${thing.model.size.join("x")} model, ${n} voxels` };
  },

  // forged content is not personal: identical (normalised) prompts share an upgraded answer across players
  cacheKey: (p) => ({ prompt: normalizeThingPrompt(p.prompt), categories: p.categories?.length ? [...p.categories].sort() : null, maxModelSize: p.maxModelSize }),
  cacheTtlSec: 24 * 3600,
  upgradeTimeoutMs: TIMEOUT_MS + 5000,
};
