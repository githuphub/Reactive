// forge.thing ("forge anything"): the forge decides what a prompt *is* (creature, food, tool, weapon, wearable,
// decoration, material or block) and returns a ForgedThing with a small coloured voxel model written in the Voxel DSL.
//
//   VoxelModel = { size: [x, y, z], palette: { key: "#rrggbb" }, ops: VoxelOp[], pivot?: [x, y, z] }
//
// Same ops as build plans (voxel.ts); `block` fields name palette keys, so every voxel is a colour. Coordinates are
// model voxels inside 0..size-1. Orientation: held items have the grip at the bottom and point up +Y; creatures face
// +Z and stand on y = 0; wearables sit on their `wearable.slot` (head items rest on the head with the pivot at the
// bottom centre).
// - clampVoxelModel(raw, opts)     untrusted JSON -> VoxelModel (palette colours, ops clamped to the size)
// - expandVoxelModel(model)        VoxelModel -> { voxels: [{x, y, z, color}], size }
// - voxelModelJsonSchema()         Anthropic structured-output schema for a model (flat ops, nullable unused fields)
// - forgedThingJsonSchema(cats)    structured-output schema for a whole ForgedThing answer
// - clampForgedThing(raw, opts)    untrusted JSON -> ForgedThing | null (null = keep the rules answer)
// The keyless rules (keyword categories + template models) are in forge-thing-rules.ts.
import { z } from "zod";
import { Bag, Hex, Id, clampNum, cleanText, hashString, isObj, oneOf } from "./common.js";
import { VoxelOp, clampVoxelPlan, voxelPlanJsonSchema, type VoxelVec } from "./voxel.js";
import { expandVoxelPlan, normalizeBlockId } from "./voxel-expand.js";

export const THING_CATEGORIES = ["weapon", "tool", "food", "creature", "wearable", "decoration", "material", "block", "vehicle"] as const;
export type ThingCategory = (typeof THING_CATEGORIES)[number];
export const THING_RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type ThingRarity = (typeof THING_RARITIES)[number];
export const THING_EFFECTS = [
  "none", "chain_lightning", "fire_trail", "vein_mine", "knockback_burst", "heal_aura", "frost_slow", "glow", "speed", "jump",
  "night_vision", "explode_on_hit",
] as const;
export type ThingEffect = (typeof THING_EFFECTS)[number];
export const THING_BEHAVIOURS = ["passive", "pet", "hostile", "neutral", "flying", "swimming", "guard"] as const;
export type ThingBehaviour = (typeof THING_BEHAVIOURS)[number];
export const THING_SLOTS = ["head", "chest", "legs", "feet", "back"] as const;
export type ThingSlot = (typeof THING_SLOTS)[number];
/** How a vehicle moves: ground (wheels, follows terrain), rail (ground, trains), water (floats), air (flies). */
export const THING_VEHICLE_MODES = ["ground", "rail", "water", "air"] as const;
export type ThingVehicleMode = (typeof THING_VEHICLE_MODES)[number];
/** Vehicle speed range in blocks per second, seats 1-4. */
export const THING_VEHICLE_LIMITS = { speed: [2, 30], seats: [1, 4] } as const;

export const THING_STAT_NAMES = ["damage", "attackSpeed", "miningSpeed", "durability", "food", "saturation", "armor", "light", "stackSize"] as const;
export type ThingStatName = (typeof THING_STAT_NAMES)[number];

/**
 * Sane stat ranges (clampForgedThing enforces them). damage in hit points, attackSpeed in swings / s, miningSpeed as
 * a multiplier (1 = hand), durability in uses, food / saturation in half-drumsticks (Minecraft-like), armor points,
 * light level 0-15, stackSize 1-64.
 */
export const THING_STAT_LIMITS: Record<ThingStatName, { min: number; max: number; int: boolean }> = {
  damage: { min: 0, max: 50, int: false },
  attackSpeed: { min: 0, max: 5, int: false },
  miningSpeed: { min: 0, max: 30, int: false },
  durability: { min: 0, max: 10_000, int: true },
  food: { min: 0, max: 20, int: true },
  saturation: { min: 0, max: 20, int: false },
  armor: { min: 0, max: 30, int: true },
  light: { min: 0, max: 15, int: true },
  stackSize: { min: 1, max: 64, int: true },
};

/** Model limits: per-axis size (default 16, max 32), voxel count after expansion, palette entries, ops, limb parts. */
export const VOXEL_MODEL_LIMITS = { defaultSize: 16, maxSize: 32, minVoxels: 8, maxVoxels: 4096, maxPalette: 16, maxOps: 60, maxParts: 12 } as const;

// ---------------------------------------------------------------- zod

const ModelDim = z.number().int().min(1).max(VOXEL_MODEL_LIMITS.maxSize);
const ModelVec = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const ItemName = z.string().min(1).max(48);

/** A small coloured voxel model (Voxel DSL ops; `block` = a palette key). */
export const VoxelModel = z.object({
  /** [x, y, z] in voxels, each <= the ask's maxModelSize. */
  size: z.tuple([ModelDim, ModelDim, ModelDim]),
  /** Palette key -> "#rrggbb". */
  palette: z.record(z.string(), Hex),
  ops: z.array(VoxelOp).max(VOXEL_MODEL_LIMITS.maxOps),
  /** Grip / attach / rotation point in model voxels (held items: the grip). */
  pivot: z.tuple([z.number(), z.number(), z.number()]).optional(),
});
export type VoxelModel = z.infer<typeof VoxelModel>;

/** One expanded model voxel. */
export interface ModelVoxel { x: number; y: number; z: number; color: string }
export interface ExpandedModel { voxels: ModelVoxel[]; size: VoxelVec }

/** A limb box inside the model (model voxels, inclusive) for simple animation: head, legs, wings, tail ... */
export const ThingPart = z.object({ name: z.string().min(1).max(32), from: ModelVec, to: ModelVec });
export type ThingPart = z.infer<typeof ThingPart>;

export const ThingCreature = z.object({
  behaviour: z.enum(THING_BEHAVIOURS),
  /** Hit points (1-1000). */
  health: z.number().min(1).max(1000),
  /** Walk / fly / swim speed in blocks per second (0-20). */
  speed: z.number().min(0).max(20),
  /** World height in blocks (0.1-16); scale the model so its height matches. */
  size: z.number().min(0.1).max(16),
  parts: z.array(ThingPart).max(VOXEL_MODEL_LIMITS.maxParts).optional(),
  /** Onomatopoeia for speech bubbles ("bawk!", "moo"). */
  sounds: z.array(z.string().max(40)).max(8),
  /** Item names dropped on death. */
  drops: z.array(ItemName).max(8),
  /** Item it produces now and then (egg). */
  lays: ItemName.optional(),
  /** Item that tames it. */
  tameWith: ItemName.optional(),
});
export type ThingCreature = z.infer<typeof ThingCreature>;

const stat = (k: ThingStatName) => z.number().min(THING_STAT_LIMITS[k].min).max(THING_STAT_LIMITS[k].max);
export const ThingStats = z.object({
  damage: stat("damage"), attackSpeed: stat("attackSpeed"), miningSpeed: stat("miningSpeed"), durability: stat("durability"),
  food: stat("food"), saturation: stat("saturation"), armor: stat("armor"), light: stat("light"), stackSize: stat("stackSize"),
});
export type ThingStats = z.infer<typeof ThingStats>;

/** A 3x3 crafting recipe: 3 rows of 3 characters (space = empty), key char -> item name. */
export const ThingRecipe = z.object({
  shape: z.array(z.string().length(3)).length(3),
  key: z.record(z.string().length(1), ItemName),
});
export type ThingRecipe = z.infer<typeof ThingRecipe>;

/** A rideable thing: how it moves, how fast (blocks/s), how many riders. */
export const ThingVehicle = z.object({
  mode: z.enum(THING_VEHICLE_MODES),
  speed: z.number(),
  seats: z.number().int(),
});
export type ThingVehicle = z.infer<typeof ThingVehicle>;

/** Clamp an untrusted vehicle bag (defaults: ground, 10 blocks/s, 1 seat). */
export function clampThingVehicle(raw: unknown, fallback?: ThingVehicle | null): ThingVehicle {
  const r = isObj(raw) ? raw : {};
  return {
    mode: oneOf(THING_VEHICLE_MODES, typeof r.mode === "string" ? r.mode.toLowerCase() : r.mode) ?? fallback?.mode ?? "ground",
    speed: clampNum(r.speed, THING_VEHICLE_LIMITS.speed[0], THING_VEHICLE_LIMITS.speed[1], fallback?.speed ?? 10),
    seats: Math.round(clampNum(r.seats, THING_VEHICLE_LIMITS.seats[0], THING_VEHICLE_LIMITS.seats[1], fallback?.seats ?? 1)),
  };
}

/** The forge.thing result: whatever the player asked for, with its model, stats and (for creatures) behaviour. */
export const ForgedThing = z.object({
  /** Deterministic: slug of the name + a short hash. */
  id: Id,
  name: z.string().min(1).max(64),
  /** One sentence. */
  description: z.string().max(240),
  /** Short in-world line. */
  flavor: z.string().max(240),
  rarity: z.enum(THING_RARITIES),
  category: z.enum(THING_CATEGORIES),
  model: VoxelModel,
  /** Every stat is present; 0 when not applicable (stackSize >= 1). */
  stats: ThingStats,
  effect: z.enum(THING_EFFECTS),
  /** Only for category "creature". */
  creature: ThingCreature.nullable(),
  /** Only for category "wearable". */
  wearable: z.object({ slot: z.enum(THING_SLOTS) }).nullable(),
  /** Only for category "vehicle": rideable (mode, speed in blocks/s, seats). Absent on older answers. */
  vehicle: ThingVehicle.nullable().optional(),
  recipe: ThingRecipe.nullable(),
  tags: z.array(z.string().max(32)).max(12),
});
export type ForgedThing = z.infer<typeof ForgedThing>;

/** forge.thing params. */
export const ForgeThingParams = z.object({
  /** What the player said ("a chicken", "a lamp made of honey"). */
  prompt: z.string().min(1).max(400),
  /** Free game context (biome, who asks, what is nearby). */
  context: Bag.optional(),
  /** Allowed categories (default: all). Anything else is re-interpreted into one of these. */
  categories: z.array(z.enum(THING_CATEGORIES)).min(1).max(THING_CATEGORIES.length).optional(),
  /** Max model size per axis in voxels (default 16). */
  maxModelSize: z.number().int().min(4).max(VOXEL_MODEL_LIMITS.maxSize).default(VOXEL_MODEL_LIMITS.defaultSize),
});
export type ForgeThingParams = z.infer<typeof ForgeThingParams>;

// ---------------------------------------------------------------- colours

/** Colour and material words -> "#rrggbb" (rules palettes, and colour words an LLM puts in a palette). */
export const THING_COLOR_WORDS: Record<string, string> = {
  red: "#d93b2b", crimson: "#b0172f", scarlet: "#e0301e", maroon: "#7a1f2a", orange: "#f08a24", yellow: "#f2d03a",
  gold: "#f2c230", golden: "#f2c230", green: "#4caf50", lime: "#9be04a", olive: "#7a8a3a", emerald: "#2fbf71", mint: "#9fe0c0",
  blue: "#3b6fd9", navy: "#1f2f6b", azure: "#3fa0f0", cyan: "#3ad6e0", teal: "#1f9a94", turquoise: "#40e0d0",
  indigo: "#4b3a9a", purple: "#8a4fd0", violet: "#9b6af0", lavender: "#b8a0e8", magenta: "#d63bd0", pink: "#f29ab8",
  brown: "#8a5a35", tan: "#d2b48c", beige: "#e8dcc0", cream: "#f3e5c0", ivory: "#fffff0", chocolate: "#5a3420",
  black: "#26262c", white: "#f4f4f0", grey: "#8d8f94", gray: "#8d8f94", silver: "#c8ccd4", bronze: "#b0763a", copper: "#c8743a",
  iron: "#d8d8d8", steel: "#b8c0c8", diamond: "#6ee0e0", ruby: "#d0213a", sapphire: "#2a4fd0", amethyst: "#9a5ad8",
  obsidian: "#2a1f3a", wood: "#b88a4e", wooden: "#b88a4e", oak: "#b88a4e", stone: "#8d8f94", ice: "#bfefff", icy: "#bfefff",
  frost: "#bfefff", frozen: "#bfefff", fire: "#ff6a1a", flame: "#ff6a1a", fiery: "#ff6a1a", lava: "#ff5a10", molten: "#ff5a10",
  glass: "#a8d8f0", crystal: "#c8f0ff", ghostly: "#eef0ff", toxic: "#9be04a", holy: "#fff4c0", shadow: "#2a2633",
};

/** "#rgb" / "#rrggbb" / "rrggbb" / a colour word -> "#rrggbb" (lowercase), else "". */
export function parseThingColor(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim().toLowerCase();
  const m6 = /^#?([0-9a-f]{6})$/.exec(s);
  if (m6) return `#${m6[1]}`;
  const m3 = /^#([0-9a-f]{3})$/.exec(s);
  if (m3) return `#${m3[1].split("").map((c) => c + c).join("")}`;
  return THING_COLOR_WORDS[s.replace(/[\s-]+/g, "_")] ?? THING_COLOR_WORDS[s.split(/[\s_-]+/).pop() ?? ""] ?? "";
}

const FALLBACK_COLOR = "#9a9a9a";

// ---------------------------------------------------------------- clamp + expand

const clampInt = (v: unknown, lo: number, hi: number, d: number) => Math.round(clampNum(typeof v === "string" ? Number(v) : v, lo, hi, d));

function vec3(v: unknown): VoxelVec | null {
  const a = Array.isArray(v) ? v : isObj(v) ? [v.x, v.y, v.z] : null;
  if (!a || a.length < 3) return null;
  const n = a.slice(0, 3).map((x) => (typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN));
  return n.every((x) => Number.isFinite(x)) ? [n[0], n[1], n[2]] : null;
}

function walkOps(ops: VoxelOp[], fn: (op: { block?: string }) => void): void {
  for (const op of ops) {
    if (op.op === "repeat" || op.op === "mirror") walkOps(op.ops, fn);
    else fn(op as { block?: string });
  }
}

export interface VoxelModelClampOptions {
  /** Max size per axis (default 16, at most 32). */
  maxSize?: number;
  /** Trailing ops are dropped until the model fits (default 4096). */
  maxVoxels?: number;
}

/**
 * Untrusted JSON (LLM answer: palette as [{key, color}] or {key: color}; flat or nested ops) -> a valid VoxelModel:
 * size clamped to 1..maxSize, colours validated (colour words allowed), ops clamped into the model box, block refs
 * that are colours added to the palette, unknown refs mapped to the first palette key. Never throws.
 */
export function clampVoxelModel(raw: unknown, opts: VoxelModelClampOptions = {}): VoxelModel {
  const maxSize = clampInt(opts.maxSize, 1, VOXEL_MODEL_LIMITS.maxSize, VOXEL_MODEL_LIMITS.defaultSize);
  const r = isObj(raw) ? raw : {};
  const sv = vec3(r.size);
  const size: VoxelVec = sv ? (sv.map((x) => clampInt(x, 1, maxSize, maxSize)) as VoxelVec) : [maxSize, maxSize, maxSize];
  const palette: Record<string, string> = {};
  const addColor = (k: unknown, c: unknown) => {
    const key = normalizeBlockId(k);
    const color = parseThingColor(c);
    if (key && key !== "air" && color && !(key in palette) && Object.keys(palette).length < VOXEL_MODEL_LIMITS.maxPalette) palette[key] = color;
  };
  if (Array.isArray(r.palette)) {
    for (const e of r.palette) if (isObj(e)) addColor(e.key ?? e.name, e.color ?? e.hex ?? e.value);
  } else if (isObj(r.palette)) {
    for (const [k, c] of Object.entries(r.palette)) addColor(k, c);
  }
  if (!Object.keys(palette).length) palette.main = FALLBACK_COLOR;
  const keys = Object.keys(palette);
  const plan = clampVoxelPlan(
    { name: "model", palette: Object.fromEntries(keys.map((k) => [k, k])), ops: r.ops },
    { site: size, maxOps: VOXEL_MODEL_LIMITS.maxOps, maxBlocks: Math.max(1, Math.round(opts.maxVoxels ?? VOXEL_MODEL_LIMITS.maxVoxels)) },
  );
  // refs that are colours ("ff0000", "red") join the palette; anything else unknown falls back to the first key
  walkOps(plan.ops, (op) => {
    if (op.block === undefined || op.block in palette) return;
    const c = parseThingColor(op.block);
    if (c && Object.keys(palette).length < VOXEL_MODEL_LIMITS.maxPalette) palette[op.block] = c;
    else if (op.block !== "air" && op.block !== "glass" && op.block !== "door") op.block = keys[0];
  });
  const model: VoxelModel = { size, palette, ops: plan.ops };
  const pv = vec3(r.pivot);
  if (pv) model.pivot = pv.map((x, i) => Math.max(0, Math.min(size[i] - 1, Math.round(x * 2) / 2))) as VoxelVec;
  return model;
}

/**
 * Expands a model into coloured voxels (air removed), in build order (y ascending). Thin wrapper over
 * expandVoxelPlan with palette keys resolved to colours; voxels outside the model size are dropped.
 *
 * ```ts
 * const { voxels } = expandVoxelModel(thing.model);
 * for (const v of voxels) mesh.addCube(v.x, v.y, v.z, v.color);
 * ```
 */
export function expandVoxelModel(model: VoxelModel): ExpandedModel {
  const size = model.size.map((x) => Math.max(1, Math.min(VOXEL_MODEL_LIMITS.maxSize, Math.round(x)))) as VoxelVec;
  const ex = expandVoxelPlan({ name: "model", palette: {}, ops: model.ops }, { site: size, maxBlocks: size[0] * size[1] * size[2] });
  const first = Object.values(model.palette)[0] ?? FALLBACK_COLOR;
  const colorOf = new Map<string, string>();
  const resolve = (ref: string): string => {
    let c = colorOf.get(ref);
    if (c) return c;
    c = model.palette[ref] ?? (ref === "glass" ? THING_COLOR_WORDS.glass : parseThingColor(ref)) ?? "";
    if (!c) c = first;
    colorOf.set(ref, c);
    return c;
  };
  const voxels: ModelVoxel[] = [];
  for (const b of ex.blocks) if (b.block !== "air") voxels.push({ x: b.x, y: b.y, z: b.z, color: resolve(b.block) });
  return { voxels, size };
}

// ---------------------------------------------------------------- structured-output schemas

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const nul = (s: Record<string, unknown>) => ({ anyOf: [s, { type: "null" }] });
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const vecSchema = { type: "array", items: { type: "integer" } };

/**
 * JSON Schema for a VoxelModel answer in the Anthropic structured-output subset (every property required,
 * additionalProperties false, nullable where unused). Palette is [{key, color}]; pivot is [x, y, z]; ops are the flat Voxel DSL ops of
 * voxelPlanJsonSchema (block = a palette key). Always pass the answer through clampVoxelModel.
 */
export function voxelModelJsonSchema(): Record<string, unknown> {
  const plan = voxelPlanJsonSchema() as { properties: { ops: unknown } };
  return obj({
    size: vecSchema,
    palette: { type: "array", items: obj({ key: str, color: str }) },
    ops: plan.properties.ops,
    pivot: { type: "array", items: num },
  });
}

/**
 * JSON Schema for a whole ForgedThing answer (categories = the allowed subset). creature / wearable / recipe are
 * nullable; creature.lays / tameWith use "" for none (fewer union types). Clamp with clampForgedThing.
 */
export function forgedThingJsonSchema(categories: readonly ThingCategory[] = THING_CATEGORIES): Record<string, unknown> {
  const cats = categories.length ? [...new Set(categories)] : [...THING_CATEGORIES];
  return obj({
    category: { type: "string", enum: cats },
    name: str,
    description: str,
    flavor: str,
    rarity: { type: "string", enum: [...THING_RARITIES] },
    effect: { type: "string", enum: [...THING_EFFECTS] },
    stats: obj(Object.fromEntries(THING_STAT_NAMES.map((k) => [k, num]))),
    creature: nul(obj({
      behaviour: { type: "string", enum: [...THING_BEHAVIOURS] },
      health: num,
      speed: num,
      size: num,
      parts: { type: "array", items: obj({ name: str, from: vecSchema, to: vecSchema }) },
      sounds: { type: "array", items: str },
      drops: { type: "array", items: str },
      lays: str,
      tameWith: str,
    })),
    wearable: nul(obj({ slot: { type: "string", enum: [...THING_SLOTS] } })),
    vehicle: nul(obj({ mode: { type: "string", enum: [...THING_VEHICLE_MODES] }, speed: num, seats: num })),
    recipe: nul(obj({ shape: { type: "array", items: str }, key: { type: "array", items: obj({ char: str, item: str }) } })),
    tags: { type: "array", items: str },
    model: voxelModelJsonSchema(),
  });
}

// ---------------------------------------------------------------- clamp a whole thing

/** Deterministic id: slug of the name + a short hash of the name and `salt` (the prompt). */
export function thingId(name: string, salt = ""): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "thing";
  return `${slug}_${hashString(`${name}|${salt}`).toString(36).slice(0, 6)}`;
}

/** Item names: lowercase snake_case ("raw_chicken"). */
export const thingItemName = (v: unknown): string => normalizeBlockId(v).replace(/^_+|_+$/g, "").slice(0, 48);

const DEFAULT_STACK: Record<ThingCategory, number> = { weapon: 1, tool: 1, food: 64, creature: 1, wearable: 1, decoration: 16, material: 64, block: 64, vehicle: 1 };

/** Clamp a stats bag to THING_STAT_LIMITS (missing = 0; stackSize defaults per category; saturation <= food). */
export function clampThingStats(raw: unknown, category: ThingCategory, fallback?: Partial<ThingStats>): ThingStats {
  const r = isObj(raw) ? raw : {};
  const out = {} as ThingStats;
  for (const k of THING_STAT_NAMES) {
    const lim = THING_STAT_LIMITS[k];
    const d = fallback?.[k] ?? (k === "stackSize" ? DEFAULT_STACK[category] : 0);
    const v = clampNum(r[k], lim.min, lim.max, clampNum(d, lim.min, lim.max, lim.min));
    out[k] = lim.int ? Math.round(v) : Math.round(v * 100) / 100;
  }
  out.saturation = Math.min(out.saturation, out.food);
  return out;
}

function clampParts(raw: unknown, size: VoxelVec): ThingPart[] {
  if (!Array.isArray(raw)) return [];
  const out: ThingPart[] = [];
  const inBox = (v: VoxelVec) => v.map((x, i) => Math.max(0, Math.min(size[i] - 1, Math.round(x)))) as VoxelVec;
  for (const p of raw) {
    if (out.length >= VOXEL_MODEL_LIMITS.maxParts) break;
    if (!isObj(p)) continue;
    const name = thingItemName(p.name);
    const from = vec3(p.from);
    const to = vec3(p.to);
    if (name && from && to) out.push({ name, from: inBox(from), to: inBox(to) });
  }
  return out;
}

const textList = (v: unknown, max: number, len: number) =>
  Array.isArray(v) ? [...new Set(v.map((x) => cleanText(x, len)).filter(Boolean))].slice(0, max) : [];
const itemList = (v: unknown, max: number) =>
  Array.isArray(v) ? [...new Set(v.map(thingItemName).filter(Boolean))].slice(0, max) : [];

/** Clamp creature data (behaviour, health, speed, size, parts inside the model, sounds, drops, lays, tameWith). */
export function clampThingCreature(raw: unknown, size: VoxelVec, fallback?: ThingCreature | null): ThingCreature {
  const r = isObj(raw) ? raw : {};
  const fb = fallback ?? null;
  const out: ThingCreature = {
    behaviour: oneOf(THING_BEHAVIOURS, typeof r.behaviour === "string" ? r.behaviour.toLowerCase() : r.behaviour) ?? fb?.behaviour ?? "passive",
    health: Math.round(clampNum(r.health, 1, 1000, fb?.health ?? 10)),
    speed: Math.round(clampNum(r.speed, 0, 20, fb?.speed ?? 3) * 100) / 100,
    size: Math.round(clampNum(r.size, 0.1, 16, fb?.size ?? 1) * 100) / 100,
    sounds: textList(r.sounds, 6, 40),
    drops: itemList(r.drops, 6),
  };
  if (!out.sounds.length && fb) out.sounds = fb.sounds;
  const parts = clampParts(r.parts, size);
  if (parts.length) out.parts = parts;
  const lays = thingItemName(r.lays);
  if (lays) out.lays = lays;
  const tame = thingItemName(r.tameWith);
  if (tame) out.tameWith = tame;
  return out;
}

/** Clamp a recipe: 3 rows of 3 chars, key chars present in the shape; null when empty or invalid. */
export function clampThingRecipe(raw: unknown): ThingRecipe | null {
  if (!isObj(raw)) return null;
  const key: Record<string, string> = {};
  const add = (c: unknown, item: unknown) => {
    const ch = typeof c === "string" ? c.trim().slice(0, 1) : "";
    const it = thingItemName(item);
    if (ch && ch !== " " && it && Object.keys(key).length < 9) key[ch] = it;
  };
  if (Array.isArray(raw.key)) for (const e of raw.key) { if (isObj(e)) add(e.char ?? e.key, e.item ?? e.name); }
  else if (isObj(raw.key)) for (const [c, it] of Object.entries(raw.key)) add(c, it);
  const rows = Array.isArray(raw.shape) ? raw.shape.slice(0, 3).map((s) => (typeof s === "string" ? s : "")) : [];
  while (rows.length < 3) rows.push("");
  const shape = rows.map((s) => [...s.padEnd(3, " ").slice(0, 3)].map((c) => (c in key ? c : " ")).join(""));
  const used = new Set(shape.join("").replace(/ /g, ""));
  for (const c of Object.keys(key)) if (!used.has(c)) delete key[c];
  return used.size ? { shape, key } : null;
}

export interface ForgedThingClampOptions {
  /** The player's prompt (id salt). */
  prompt: string;
  maxModelSize?: number;
  /** Allowed categories (default all). */
  categories?: readonly ThingCategory[];
  /** The rules answer: fills gaps (name, rarity, creature data ...). */
  fallback?: ForgedThing;
}

/**
 * Untrusted JSON (an LLM answer to forgedThingJsonSchema) -> a valid ForgedThing, or null when the model is unusable
 * (fewer than 8 or more than 4096 voxels after clamping) so the caller keeps its rules answer. Never throws.
 */
export function clampForgedThing(raw: unknown, opts: ForgedThingClampOptions): ForgedThing | null {
  if (!isObj(raw)) return null;
  const fb = opts.fallback;
  const allowed = opts.categories?.length ? opts.categories : THING_CATEGORIES;
  let category = oneOf(THING_CATEGORIES, typeof raw.category === "string" ? raw.category.toLowerCase() : raw.category);
  if (!category || !allowed.includes(category)) category = fb && allowed.includes(fb.category) ? fb.category : allowed[0];
  const model = clampVoxelModel(raw.model, { maxSize: opts.maxModelSize, maxVoxels: 1_000_000 });
  const n = expandVoxelModel(model).voxels.length;
  if (n < VOXEL_MODEL_LIMITS.minVoxels || n > VOXEL_MODEL_LIMITS.maxVoxels) return null;
  const name = cleanText(raw.name, 64) || fb?.name || "Thing";
  const rarity = oneOf(THING_RARITIES, typeof raw.rarity === "string" ? raw.rarity.toLowerCase() : raw.rarity) ?? fb?.rarity ?? "common";
  const effect = oneOf(THING_EFFECTS, typeof raw.effect === "string" ? raw.effect.toLowerCase() : raw.effect) ?? "none";
  const wearRaw = isObj(raw.wearable) ? raw.wearable : null;
  const tags = [...new Set([category, ...itemList(raw.tags, 12)])].slice(0, 12);
  return {
    id: thingId(name, opts.prompt),
    name,
    description: cleanText(raw.description, 240) || fb?.description || "",
    flavor: cleanText(raw.flavor, 240) || fb?.flavor || "",
    rarity,
    category,
    model,
    stats: clampThingStats(raw.stats, category),
    effect,
    creature: category === "creature" ? clampThingCreature(raw.creature, model.size, fb?.creature) : null,
    wearable: category === "wearable" ? { slot: oneOf(THING_SLOTS, wearRaw?.slot) ?? fb?.wearable?.slot ?? "head" } : null,
    vehicle: category === "vehicle" ? clampThingVehicle(raw.vehicle, fb?.vehicle) : null,
    recipe: clampThingRecipe(raw.recipe),
    tags,
  };
}
