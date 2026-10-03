// The manifest item schema as the forge sees it (manifest `items`, with Counterforge-shaped defaults when a game
// declares none): families -> library templates, slots -> held / armour, stats with min / max, rarity budgets,
// creativity rules and tags. Every stat the forge emits goes through clampStats.
import type { Manifest } from "@liveforge/manifest";
import { FAMILY_DEFAULT, LIBRARY_FAMILIES, archetypeById, type Archetype } from "./library/archetypes.js";
import { pickArchetype } from "./keywords.js";
import { clampN, finOr, isObj, mulberry32, type StatBias } from "./model.js";

export interface StatRange { min: number; max: number; default?: number }

export interface ItemSchema {
  families: string[];
  slots: string[];
  rarities: string[];
  stats: Record<string, StatRange>;
  budget: number | number[];
  tags: string[];
  creativity: { max: number; rawPowerPenalty: boolean };
  assets: { id: string; kind?: string; slots?: string[] }[];
}

/** Used when the manifest has no `items` section (Counterforge's shape: 18 families, 4 stats, 5 rarities). */
export const DEFAULT_ITEM_SCHEMA: ItemSchema = {
  families: [...LIBRARY_FAMILIES],
  slots: ["weapon", "offhand", "head", "chest", "hands", "legs", "feet", "trinket"],
  rarities: ["common", "uncommon", "rare", "epic", "legendary"],
  stats: {
    damage: { min: 1, max: 100, default: 30 },
    speed: { min: 1, max: 100, default: 50 },
    range: { min: 1, max: 100, default: 30 },
    special: { min: 0, max: 100, default: 10 },
  },
  budget: [1.4, 1.6, 1.9, 2.2, 2.6],
  tags: [],
  creativity: { max: 0.7, rawPowerPenalty: true },
  assets: [],
};

const SCHEMA_CACHE = new WeakMap<Manifest, ItemSchema>();
/** The item schema for a manifest (cached per manifest object; admin reload creates a new one). */
export function itemSchema(m: Manifest): ItemSchema {
  let s = SCHEMA_CACHE.get(m);
  if (!s) {
    const i = m.items;
    s = i
      ? {
          families: i.families, slots: i.slots, rarities: i.rarities.length ? i.rarities : ["common"], stats: i.stats,
          budget: i.budget, tags: i.tags, creativity: i.creativity, assets: i.assets,
        }
      : DEFAULT_ITEM_SCHEMA;
    SCHEMA_CACHE.set(m, s);
  }
  return s;
}

// ------------------------------------------------------------------------------------------------ slots

/** What kind of model a slot takes. */
export type SlotKind = "weapon" | "offhand" | "head" | "chest" | "shoulders" | "back" | "hands" | "legs" | "feet" | "waist" | "trinket";

const SLOT_WORDS: Array<[SlotKind, RegExp]> = [
  ["weapon", /^(weapon|main|mainhand|main_hand|primary|melee|ranged|held|hand_r|right_hand)$/],
  ["offhand", /^(offhand|off_hand|secondary|shield|hand_l|left_hand)$/],
  ["head", /^(head|helm|helmet|hat|hood|crown|face|mask)$/],
  ["chest", /^(chest|body|torso|armour|armor|cuirass|robe|shirt)$/],
  ["shoulders", /^(shoulder|shoulders|pauldrons?)$/],
  ["back", /^(back|cape|cloak|mantle)$/],
  ["hands", /^(hands|hand|gloves?|gauntlets?|wrists?|bracers?)$/],
  ["legs", /^(legs|leg|greaves|pants|trousers)$/],
  ["feet", /^(feet|foot|boots?|shoes?)$/],
  ["waist", /^(waist|belt|sash)$/],
  ["trinket", /^(trinket|neck|amulet|necklace|ring|rings|finger|charm|relic|accessory)$/],
];

/** Classify a manifest slot name. Unknown names are treated as a trinket. */
export function slotKind(slot: string): SlotKind {
  const s = slot.trim().toLowerCase();
  for (const [k, re] of SLOT_WORDS) if (re.test(s)) return k;
  return "trinket";
}
export const isArmourSlot = (slot: string): boolean => !["weapon", "offhand"].includes(slotKind(slot));

/** Prompt words that mean an armour slot ("frost crown" -> head). */
const ARMOUR_PROMPT: Array<[SlotKind, RegExp]> = [
  ["head", /\b(helmet|helm|crown|hat|hood|mask|circlet|tiara|diadem|visor|cap)s?\b/i],
  ["shoulders", /\b(pauldrons?|spaulders?|shoulder ?guards?|epaulettes?)\b/i],
  ["back", /\b(capes?|cloaks?|mantles?)\b/i],
  ["chest", /\b(breastplate|chestplate|cuirass|armou?r|robe|vest|tunic|chainmail|mail shirt|jerkin)s?\b/i],
  ["hands", /\b(gloves?|bracers?|vambraces?)\b/i],
  ["legs", /\b(greaves|leggings|trousers|pants|cuisses)\b/i],
  ["feet", /\b(boots?|shoes?|sabatons|sandals?)\b/i],
  ["waist", /\b(belts?|sash|girdle)\b/i],
  ["trinket", /\b(amulet|necklace|pendant|ring|charm|talisman|brooch|earring|relic)s?\b/i],
];

/** Armour slot kind a prompt names in its head phrase, or null. */
export function promptSlotKind(text: string): SlotKind | null {
  const cut = text.search(/\b(?:of|on|with|from|for|in|made|that|which)\b/i);
  const head = cut < 0 ? text : text.slice(0, cut);
  for (const t of [head, text]) for (const [k, re] of ARMOUR_PROMPT) if (re.test(t)) return k;
  return null;
}

/** The manifest slot for a slot kind (first slot of that kind), or null when the game has none. */
export function slotFor(schema: ItemSchema, kind: SlotKind): string | null {
  return schema.slots.find((s) => slotKind(s) === kind) ?? null;
}

// ------------------------------------------------------------------------------------------------ families

const TEMPLATE_CACHE = new Map<string, string>();
/**
 * Library family a manifest family maps onto: itself when it is one of the 18 library families, else the family of
 * the archetype its name names ("katana" -> sword, "pistol" -> gun, "wand" -> focus), else "sword".
 */
export function familyTemplate(family: string): string {
  const key = family.toLowerCase();
  const hit = TEMPLATE_CACHE.get(key);
  if (hit) return hit;
  let t = (LIBRARY_FAMILIES as readonly string[]).includes(key) ? key : null;
  if (!t) t = pickArchetype(key.replace(/[_-]+/g, " "), "held")?.family ?? null;
  if (!t) {
    if (/shield|buckler|ward/.test(key)) t = "shield_small";
    else if (/magic|spell|wand|book|tome|orb|focus|catalyst/.test(key)) t = "focus";
    else if (/polearm|lance|pike/.test(key)) t = "spear";
    else if (/heavy|blunt|mace|club/.test(key)) t = "hammer";
    else if (/ranged|bow|archer/.test(key)) t = "bow";
    else if (/firearm|gun|rifle/.test(key)) t = "gun";
    else if (/blade|edge|sword/.test(key)) t = "sword";
    else t = "sword";
  }
  TEMPLATE_CACHE.set(key, t);
  return t;
}

/** The manifest family for a library archetype (a family whose template is the archetype's family), else null. */
export function manifestFamilyFor(schema: ItemSchema, arch: Archetype): string | null {
  return schema.families.find((f) => f.toLowerCase() === arch.family)
    ?? schema.families.find((f) => f.toLowerCase() === arch.id)
    ?? schema.families.find((f) => familyTemplate(f) === arch.family)
    ?? null;
}

/** Default archetype of a manifest family (its own name if it names one, else the template default). */
export function familyArchetype(family: string): Archetype {
  const named = pickArchetype(family.toLowerCase().replace(/[_-]+/g, " "), "held");
  const t = familyTemplate(family);
  if (named && named.family === t) return named;
  return archetypeById(FAMILY_DEFAULT[t] ?? "arming_sword") ?? archetypeById("arming_sword")!;
}

// ------------------------------------------------------------------------------------------------ rarity, budget, stats

/** Budget (sum of 0-1 normalised stats) for a rarity index. */
export function budgetFor(schema: ItemSchema, rarityIndex: number): number {
  const b = schema.budget;
  if (typeof b === "number") return b;
  return b[clampN(Math.round(rarityIndex), 0, b.length - 1)] ?? b[b.length - 1] ?? 2;
}

export function rarityIndexOf(schema: ItemSchema, rarity: unknown): number {
  const i = typeof rarity === "string" ? schema.rarities.findIndex((r) => r.toLowerCase() === rarity.toLowerCase()) : -1;
  return i;
}

/** Map a stat name onto the four template biases (unknown names get an even share). */
function biasKey(stat: string): keyof StatBias | "defence" | null {
  const s = stat.toLowerCase();
  if (/^(damage|dmg|attack|atk|power|might|strength|str|force)$/.test(s)) return "damage";
  if (/^(speed|haste|agility|agi|dex|dexterity|attack_speed|rate)$/.test(s)) return "speed";
  if (/^(range|reach|distance|accuracy)$/.test(s)) return "range";
  if (/^(special|magic|mana|spell|arcane|int|intelligence|luck|crit|critical)$/.test(s)) return "special";
  if (/^(defence|defense|armou?r|def|block|resist|resistance|toughness|hp|health|vitality|vit|stamina)$/.test(s)) return "defence";
  return null;
}

/**
 * Keyless stats: `target` (0..budget) spread over the manifest stats by the template's bias (armour pieces weight
 * defence-like stats, weapons weight damage-like ones), seeded noise, each 0-1 of its range, then rounded.
 */
export function rollStats(schema: ItemSchema, opts: { bias: StatBias; armour: boolean; rarityIndex: number; power: number; seed: number }): Record<string, number> {
  const names = Object.keys(schema.stats);
  if (!names.length) return {};
  const rnd = mulberry32(opts.seed ^ 0x2545f491);
  const weights = names.map((n) => {
    const k = biasKey(n);
    let w: number;
    if (k === "defence") w = opts.armour ? 60 : 8;
    else if (k) w = opts.armour ? (k === "special" ? 30 : 10) : opts.bias[k];
    else w = 25;
    return Math.max(1, w * (0.8 + rnd() * 0.4));
  });
  const budget = budgetFor(schema, opts.rarityIndex);
  const target = budget * clampN(opts.power, 0.1, 1);
  const norm = distribute(weights, target);
  const out: Record<string, number> = {};
  names.forEach((n, i) => (out[n] = denorm(schema.stats[n], norm[i])));
  return out;
}

/** Spread `target` over weights, each share capped at 1 (overflow redistributed). */
function distribute(weights: number[], target: number): number[] {
  const out = weights.map(() => 0);
  let left = Math.min(target, weights.length);
  let open = weights.map((_, i) => i);
  for (let iter = 0; iter < 8 && left > 1e-6 && open.length; iter++) {
    const wsum = open.reduce((a, i) => a + weights[i], 0) || 1;
    let spent = 0;
    for (const i of open) {
      const add = Math.min(1 - out[i], (left * weights[i]) / wsum);
      out[i] += add;
      spent += add;
    }
    left -= spent;
    open = open.filter((i) => out[i] < 1 - 1e-9);
  }
  return out;
}

const isInt = (r: StatRange) => Number.isInteger(r.min) && Number.isInteger(r.max) && r.max - r.min >= 5;
function denorm(r: StatRange, v: number): number {
  const x = r.min + clampN(v, 0, 1) * (r.max - r.min);
  return isInt(r) ? Math.round(x) : Math.round(x * 100) / 100;
}
const normOf = (r: StatRange, v: number) => (r.max > r.min ? (v - r.min) / (r.max - r.min) : 0);

/**
 * Clamp untrusted stats to the manifest schema: unknown names dropped, each value clamped to [min, max] (missing ->
 * default or min), then the 0-1-normalised sum is scaled down to the rarity budget. Never throws.
 */
export function clampStats(schema: ItemSchema, raw: unknown, rarityIndex: number): Record<string, number> {
  const src = isObj(raw) ? raw : {};
  const names = Object.keys(schema.stats);
  const norm = names.map((n) => {
    const r = schema.stats[n];
    const v = clampN(finOr(src[n], r.default ?? r.min), r.min, r.max);
    return clampN(normOf(r, v), 0, 1);
  });
  const budget = budgetFor(schema, rarityIndex);
  const sum = norm.reduce((a, x) => a + x, 0);
  const f = sum > budget && sum > 0 ? budget / sum : 1;
  const out: Record<string, number> = {};
  names.forEach((n, i) => (out[n] = denorm(schema.stats[n], norm[i] * f)));
  return out;
}

// ------------------------------------------------------------------------------------------------ tags

/** Prompt / family cues for common tag names (Counterforge traits + generic ones). Unknown tags match their own name. */
const TAG_CUES: Record<string, RegExp> = {
  piercing: /\b(pierc\w*|spear|lance|arrow|bolt|needle|rapier|stiletto|harpoon|drill|javelin|pike)\b/i,
  reflective: /\b(mirror|reflect\w*|polished|chrome|silver|crystal)\b/i,
  grapple: /\b(chain|hook|grappl\w*|whip|rope|lasso|tether|kusarigama|harpoon)\b/i,
  knockback: /\b(hammer|maul|club|knock\w*|shove|blast|gust|mallet|anchor)\b/i,
  lifesteal: /\b(vampir\w*|blood\w*|leech\w*|drain\w*|life ?steal|soul)\b/i,
  swift: /\b(swift|quick|fast|light|feather\w*|wind|dagger|knife|nimble|rapid)\b/i,
  heavy: /\b(heavy|huge|giant|great|massive|anvil|tower|colossal|iron)\b/i,
  explosive: /\b(explo\w*|bomb|blast|grenade|rocket|dynamite|boom|cannon|volatile)\b/i,
};
const FAMILY_TAGS: Record<string, string[]> = {
  spear: ["piercing"], bow: ["piercing"], crossbow: ["piercing"], hammer: ["knockback", "heavy"], greatsword: ["heavy"],
  dagger: ["swift"], whip: ["grapple"], cannon: ["explosive"], shield_small: ["reflective"], shield_large: ["heavy"],
};

/** Tags from the manifest tag list that the prompt or template implies (at most `max`). */
export function pickTags(schema: ItemSchema, text: string, template: string | null, max = 2): string[] {
  const out: string[] = [];
  for (const tag of schema.tags) {
    if (out.length >= max) break;
    const key = tag.toLowerCase();
    const re = TAG_CUES[key] ?? new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) out.push(tag);
  }
  if (!out.length && template) {
    for (const k of FAMILY_TAGS[template] ?? []) {
      const tag = schema.tags.find((t) => t.toLowerCase() === k);
      if (tag && out.length < max) out.push(tag);
    }
  }
  return out;
}

/** Keep only manifest tags (case-insensitive), deduplicated, at most `max`. */
export function cleanTags(schema: ItemSchema, raw: unknown, max = 3): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const hit = schema.tags.find((x) => x.toLowerCase() === t.toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
    if (out.length >= max) break;
  }
  return out;
}
